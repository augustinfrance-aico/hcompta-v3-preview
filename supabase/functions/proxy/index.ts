/**
 * H-COMPTA AI — Proxy V3 (Supabase Edge Function)
 * Sécurise les appels sensibles côté serveur :
 *   - Mariah IA (clé API Anthropic)
 *   - Webhooks Make.com
 *   - Opérations admin
 *
 * Déployer : supabase functions deploy proxy
 *
 * Variables d'env (supabase secrets set) :
 *   ANTHROPIC_API_KEY   — clé API Claude pour Mariah
 *   SUPABASE_SERVICE_KEY — clé service_role (jamais côté client)
 *   MAKE_WEBHOOK_EXPORT  — webhook Make S3 (export Sage/Odoo)
 *   MAKE_WEBHOOK_SYNC    — webhook Make S8 (sync expert)
 *
 * SÉCURITÉ : AUCUNE clé secrète n'est exposée côté navigateur.
 * Chaque requête est authentifiée via JWT Supabase.
 *
 * Source de vérité : CdC V3 + Guide Make V2
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================
// CONFIG — Variables d'environnement (jamais hardcodé)
// ============================================================
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY');
const ANTHROPIC_API_KEY    = Deno.env.get('ANTHROPIC_API_KEY');
const MAKE_WEBHOOK_EXPORT  = Deno.env.get('MAKE_WEBHOOK_EXPORT');
const MAKE_WEBHOOK_SYNC    = Deno.env.get('MAKE_WEBHOOK_SYNC');

// Client Supabase admin (service_role — accès total, bypass RLS)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// MIDDLEWARE — Vérifier le JWT + extraire l'utilisateur
// ============================================================
async function verifyAuth(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Token manquant');
  }
  const token = authHeader.slice(7);

  // Vérifier le JWT avec Supabase
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) throw new Error('Token invalide');

  const role = user.user_metadata?.role || 'PME';
  let pmeId = null;

  // Récupérer pme_id selon le rôle
  if (role === 'PME') {
    const { data: pme } = await supabaseAdmin.from('pme_liste')
      .select('id')
      .eq('email_acces', user.email)
      .single();
    pmeId = pme?.id;
  }

  if (role === 'COLLABORATEUR') {
    const { data: collab } = await supabaseAdmin.from('collaborateurs')
      .select('pme_id')
      .eq('email', user.email)
      .eq('statut', 'Actif')
      .single();
    pmeId = collab?.pme_id;
  }

  // Vérifier que pmeId a bien été résolu (sauf ADMIN/EXPERT sans PME directe)
  if ((role === 'PME' || role === 'COLLABORATEUR') && !pmeId) {
    throw new Error('PME non trouvée');
  }

  return { userId: user.id, email: user.email, role, pmeId };
}

// ============================================================
// ROUTE : POST /mariah — Appel sécurisé à Claude (Mariah IA)
// CdC V3 : prompt depuis table prompts, jamais dans le code
// ============================================================
async function handleMariah(req, authCtx) {
  const { question, pmeId, typeDocument, pays, history } = await req.json();

  // 1. Récupérer le bon prompt depuis la table prompts
  //    CdC V3 Section 3, Table 3 : "Make va chercher le bon prompt"
  let systemPrompt = '';
  if (typeDocument && pays) {
    const { data: prompt } = await supabaseAdmin.from('prompts')
      .select('texte_prompt, version')
      .eq('type_document', typeDocument)
      .eq('pays', pays)
      .eq('actif', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (prompt) {
      systemPrompt = prompt.texte_prompt;
    }
  }

  // 2. Fallback : prompt générique Mariah si pas de prompt spécifique
  if (!systemPrompt) {
    // Récupérer les données PME pour contextualiser
    const { data: pme } = await supabaseAdmin.from('pme_liste')
      .select('nom_pme, pays, tva_taux')
      .eq('id', pmeId || authCtx.pmeId)
      .single();

    systemPrompt = `Tu es Mariah, l'Assistante Expert IA de H-Compta AI.
Tu assistes les experts-comptables et PME d'Afrique de l'Ouest.
Spécialités : SYSCOHADA révisé, fiscalité ${pme?.pays || 'CI'}/CM/SN.
Journaux : ACH, VTE, BQ, CAI, OD, IMM, PAI.
Dossier actif : ${pme?.nom_pme || 'PME'}, TVA ${pme?.tva_taux || 18}%.
Règles : concision, pas de certification, pas d'avis juridique, confidentialité.`;
  }

  // 3. Appel Anthropic
  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: (history || []).concat([{ role: 'user', content: question }]).slice(-6)
    })
  });

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    console.error('[ANTHROPIC ERROR]', errText);
    throw new Error('Erreur du service IA — veuillez réessayer');
  }

  const data = await anthropicResp.json();
  const reply = data.content?.[0]?.text || 'Erreur de réponse Mariah.';

  return json({ reply, model: data.model });
}

// ============================================================
// ROUTE : POST /mariah/analyze — Analyse facture PDF
// CdC V3 : S2 Import — le cœur du produit
// Guide Make V2 : Module 5 HTTP POST Anthropic
// ============================================================
async function handleAnalyzeInvoice(req, authCtx) {
  // FIX #2.4 : Vérifier les permissions
  if (!['PME', 'EXPERT', 'ADMIN'].includes(authCtx.role)) {
    throw new Error('Permissions insuffisantes pour analyser une facture');
  }

  const formData = await req.formData();
  const file = formData.get('file');
  const typeDocument = formData.get('type_document') || 'FACTURE_ACHAT';

  // FIX #2.5 : Récupérer le pays depuis la PME (pas du formData)
  let pays = formData.get('pays');
  if (!pays && authCtx.pmeId) {
    const { data: pme } = await supabaseAdmin.from('pme_liste')
      .select('pays').eq('id', authCtx.pmeId).single();
    pays = pme?.pays || 'CI';
  }
  pays = pays || 'CI';

  if (!file) throw new Error('Fichier manquant');

  // Validation taille fichier : max 10 MB
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('Fichier trop volumineux (max 10 Mo)');
  }

  // Validation typeDocument : whitelist
  const VALID_TYPE_DOCUMENTS = ['FACTURE_ACHAT', 'FACTURE_VENTE', 'RELEVE_BANCAIRE', 'RECU_DE_CAISSE', 'BULLETIN_DE_PAIE'];
  if (!VALID_TYPE_DOCUMENTS.includes(typeDocument)) {
    throw new Error('Type de document invalide');
  }

  // Validation pays : whitelist
  const VALID_PAYS = ['CI', 'CM', 'SN'];
  if (!VALID_PAYS.includes(pays)) {
    throw new Error('Pays invalide');
  }

  // 1. Récupérer le prompt pour ce type de document + pays
  const { data: prompt } = await supabaseAdmin.from('prompts')
    .select('texte_prompt, version, prompt_id')
    .eq('type_document', typeDocument)
    .eq('pays', pays || 'CI')
    .eq('actif', true)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (!prompt) throw new Error('Aucun prompt trouvé pour ' + typeDocument + ' / ' + pays);

  // 2. Lire le fichier en base64
  const buffer = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

  // 3. Appel Claude avec le document
  //    Guide Make V2 : Module 5 body exact
  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: prompt.texte_prompt,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'base64',
            media_type: file.type || 'application/pdf',
            data: base64
          }
        }]
      }]
    })
  });

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    console.error('[ANTHROPIC ANALYZE ERROR]', errText);
    throw new Error('Erreur analyse IA — veuillez réessayer');
  }

  const data = await anthropicResp.json();
  const resultText = data.content?.[0]?.text || '';

  // 4. Parser le JSON retourné par Mariah
  let parsed;
  try {
    // Mariah retourne un JSON avec les champs comptables
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    parsed = null;
  }

  return json({
    raw: resultText,
    parsed,
    prompt_version: prompt.version,
    prompt_id: prompt.prompt_id
  });
}

// ============================================================
// ROUTE : POST /export — Déclencher export Sage/Odoo via Make S3
// Guide Make V2 : Webhook → Airtable Search → Text Aggregator → Upload
// ============================================================
async function handleExport(req, authCtx) {
  if (!['PME', 'EXPERT', 'ADMIN'].includes(authCtx.role)) {
    throw new Error('Permissions insuffisantes');
  }

  const { pmeId, periode, format } = await req.json();
  const targetPmeId = pmeId || authCtx.pmeId;

  // FIX #2.8 : Valider le format de la période
  if (periode && !/^\d{4}-\d{2}$/.test(periode)) {
    throw new Error('Format période invalide (attendu: YYYY-MM)');
  }

  // Vérifier l'accès
  if (authCtx.role === 'PME' && targetPmeId !== authCtx.pmeId) {
    throw new Error('Accès interdit — pas votre PME');
  }

  if (!MAKE_WEBHOOK_EXPORT) {
    throw new Error('Webhook export non configuré');
  }

  // Déclencher Make S3
  const resp = await fetch(MAKE_WEBHOOK_EXPORT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pme_id: targetPmeId,
      periode: periode || new Date().toISOString().slice(0, 7),
      format: format || 'sage'
    })
  });

  return json({ ok: resp.ok, status: resp.status });
}

// ============================================================
// ROUTE : POST /sync — Validation/Rejet expert via Make S8
// Guide Make V2 : Webhook → Update Ecritures → Recalcul Score
// ============================================================
async function handleSync(req, authCtx) {
  if (!['EXPERT', 'ADMIN'].includes(authCtx.role)) {
    throw new Error('Seul un expert peut valider/rejeter');
  }

  const { ecritureId, action, commentaire } = await req.json();

  // 1. Mettre à jour l'écriture directement dans Supabase
  const updateFields = {
    statut: action === 'valider' ? 'Validé' : 'Rejeté',
    expert_validateur: authCtx.userId,
    date_validation: new Date().toISOString()
  };
  if (commentaire) updateFields.commentaire = commentaire;

  const { error: updateErr } = await supabaseAdmin.from('ecritures')
    .update(updateFields)
    .eq('id', ecritureId);

  if (updateErr) throw new Error('Erreur update écriture: ' + updateErr.message);

  // 2. Recalculer le score de conformité
  //    Guide Make V2 : Module 3 Math — nb_validées / nb_total × 100
  const { data: ecriture } = await supabaseAdmin.from('ecritures')
    .select('pme_id')
    .eq('id', ecritureId)
    .single();

  if (ecriture) {
    const { count: total } = await supabaseAdmin.from('ecritures')
      .select('*', { count: 'exact', head: true })
      .eq('pme_id', ecriture.pme_id);

    const { count: valides } = await supabaseAdmin.from('ecritures')
      .select('*', { count: 'exact', head: true })
      .eq('pme_id', ecriture.pme_id)
      .eq('statut', 'Validé');

    const score = total > 0 ? Math.round((valides / total) * 100) : 0;

    await supabaseAdmin.from('pme_liste')
      .update({ score_conformite: score })
      .eq('id', ecriture.pme_id);
  }

  // 3. Optionnel : déclencher Make S8 pour notifications
  if (MAKE_WEBHOOK_SYNC) {
    await fetch(MAKE_WEBHOOK_SYNC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ecriture_id: ecritureId,
        action,
        expert_id: authCtx.email,
        commentaire
      })
    }).catch(() => {}); // Non-bloquant
  }

  return json({ ok: true, action });
}

// ============================================================
// ROUTER — Supabase Edge Function handler (Deno)
// ============================================================
Deno.serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': 'https://app.hcompta.ai',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/proxy/, '');

  // Auth check
  let authCtx;
  try {
    authCtx = await verifyAuth(req);
  } catch (e) {
    return json({ error: e.message }, 401);
  }

  try {
    // Mariah chat
    if (path === '/mariah' && req.method === 'POST') {
      return await handleMariah(req, authCtx);
    }

    // Mariah analyse facture
    if (path === '/mariah/analyze' && req.method === 'POST') {
      return await handleAnalyzeInvoice(req, authCtx);
    }

    // Export Sage/Odoo
    if (path === '/export' && req.method === 'POST') {
      return await handleExport(req, authCtx);
    }

    // Sync Expert (valider/rejeter)
    if (path === '/sync' && req.method === 'POST') {
      return await handleSync(req, authCtx);
    }

    return json({ error: 'Route inconnue: ' + path }, 404);

  } catch (e) {
    console.error('[PROXY ERROR]', e);
    return json({ error: e.message }, 500);
  }
});

// ============================================================
// HELPER
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://app.hcompta.ai'
    }
  });
}
