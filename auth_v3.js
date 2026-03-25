/**
 * H-COMPTA AI — Auth V3
 * Stack : Supabase Auth + JWT + 4 rôles (PME/EXPERT/COLLABORATEUR/ADMIN)
 * Source de vérité : CdC V3, Section 4
 *
 * Remplace : SIMULATION_MODE + makeLogin() + localStorage session
 * Par :      supabase.auth.signInWithPassword() + JWT metadata + RLS
 *
 * Injecter dans TOUS les HTML :
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="auth_v3.js"></script>
 *
 * SÉCURITÉ :
 *   - Clé anon = publique (ok côté client)
 *   - Clé service_role = JAMAIS côté client
 *   - Clé API Claude = JAMAIS côté client (Edge Function uniquement)
 */

// ============================================================
// CONFIG — Remplacer par les vraies valeurs du projet Supabase
// Dashboard → Settings → API
// ============================================================
const SUPABASE_URL  = window.HC_SUPABASE_URL || 'https://auxhvovqrevwhkpmpwrc.supabase.co';
const SUPABASE_ANON = window.HC_SUPABASE_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1eGh2b3ZxcmV2d2hrcG1wd3JjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNjQwMjUsImV4cCI6MjA4ODg0MDAyNX0.tCtDc2_pAtBrMawZUy49zteocUS6rBKaMOBNrsseoiw';

// ============================================================
// INIT SUPABASE CLIENT (singleton)
// ============================================================
let _sb = null;

function getSupabase() {
  if (!_sb) {
    if (typeof window.supabase === 'undefined') {
      throw new Error('SDK Supabase non chargé. Ajouter <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> AVANT auth_v3.js');
    }
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  }
  return _sb;
}

// ============================================================
// INSCRIPTION — PME Admin
// CdC V3 Section 4.2 : signUp + rôle en user_metadata
// ============================================================
async function hcInscription({ email, password, nomPme, pays, plan }) {
  const sb = getSupabase();

  // 1. Créer l'utilisateur Supabase Auth
  const { data: authData, error: authErr } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: {
        role: 'PME',
        nom_pme: nomPme,
        pays,
        plan
      }
    }
  });
  if (authErr) throw new Error(authErr.message);

  // 2. Créer la ligne dans pme_liste
  //    RLS : cette insertion passe car on est authentifié + service_role via trigger
  //    Alternative : utiliser un trigger Supabase on auth.users INSERT
  const { error: pmeErr } = await sb.from('pme_liste').insert({
    nom_pme:    nomPme,
    email_acces: email,
    pays,
    plan:   plan || 'TPE',  // FIX #1.1 : jamais NULL, fallback DEFAULT
    statut: 'Actif'
  });
  if (pmeErr) throw new Error('Erreur création PME: ' + pmeErr.message);

  // 3. Logger la session
  await _logSession(authData.user?.id, null, 'PME');

  return { userId: authData.user?.id, email };
}

// ============================================================
// CONNEXION
// CdC V3 Section 4.2 : signInWithPassword → JWT avec rôle
// ============================================================
async function hcConnexion({ email, password }) {
  const sb = getSupabase();

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);

  // Récupérer les infos complètes
  const session = await hcGetSession();

  // Logger la connexion
  if (session) {
    await _logSession(data.user?.id, session.pmeId, session.role);
  }

  return session;
}

// ============================================================
// SESSION — Récupérer les données de l'utilisateur connecté
// ============================================================
async function hcGetSession() {
  const sb = getSupabase();

  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) return null;

  const role = user.user_metadata?.role || 'PME';
  let sessionData = {
    userId: user.id,
    email:  user.email,
    role,
    pmeId:  null,
    nomPme: null,
    pays:   null,
    plan:   null,
    tva:    null
  };

  if (role === 'PME') {
    // PME : chercher directement dans pme_liste par email
    const { data: pme } = await sb.from('pme_liste')
      .select('id, nom_pme, pays, plan, tva_taux, score_conformite')
      .eq('email_acces', user.email)
      .single();

    if (pme) {
      sessionData.pmeId  = pme.id;
      sessionData.nomPme = pme.nom_pme;
      sessionData.pays   = pme.pays;
      sessionData.plan   = pme.plan;
      sessionData.tva    = pme.tva_taux;
      sessionData.score  = pme.score_conformite;
    }
  }

  if (role === 'COLLABORATEUR') {
    // Collaborateur : chercher dans table collaborateurs, puis récupérer la PME
    const { data: collab } = await sb.from('collaborateurs')
      .select('pme_id')
      .eq('email', user.email)
      .eq('statut', 'Actif')
      .single();

    if (collab) {
      const { data: pme } = await sb.from('pme_liste')
        .select('id, nom_pme, pays, plan, tva_taux, score_conformite')
        .eq('id', collab.pme_id)
        .single();

      if (pme) {
        sessionData.pmeId  = pme.id;
        sessionData.nomPme = pme.nom_pme;
        sessionData.pays   = pme.pays;
        sessionData.plan   = pme.plan;
        sessionData.tva    = pme.tva_taux;
        sessionData.score  = pme.score_conformite;
      }
    }
  }

  if (role === 'EXPERT') {
    // Récupérer son cabinet
    const { data: cabinet } = await sb.from('cabinets')
      .select('id, nom_cabinet, nb_pme')
      .eq('email_expert', user.email)
      .single();

    if (cabinet) {
      sessionData.cabinetId  = cabinet.id;
      sessionData.nomCabinet = cabinet.nom_cabinet;
      sessionData.nbPme      = cabinet.nb_pme;
    }

    // Récupérer la liste de ses PME
    const { data: pmes } = await sb.from('pme_liste')
      .select('id, nom_pme, pays, score_conformite, statut')
      .eq('email_expert', user.email);

    sessionData.pmes = pmes || [];
  }

  // Stocker en sessionStorage (pour accès rapide côté DOM)
  sessionStorage.setItem('hc_session', JSON.stringify(sessionData));
  return sessionData;
}

// ============================================================
// DÉCONNEXION
// CdC V3 Condition recette n°9 : session invalidée côté Supabase
// ============================================================
async function hcDeconnexion() {
  const sb = getSupabase();
  // FIX #3.9 : Cleanup Realtime + intervals avant déconnexion
  if (typeof hcCleanup === 'function') hcCleanup();
  sessionStorage.removeItem('hc_session');
  await sb.auth.signOut();
  window.location.href = 'login.html';
}

// ============================================================
// RESET MOT DE PASSE
// CdC V3 : S7 quasi supprimé — Supabase Auth natif
// ============================================================
async function hcResetPassword(email) {
  const sb = getSupabase();
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/login.html?reset=true'
  });
  if (error) throw new Error(error.message);
  return true;
}

// ============================================================
// MISE À JOUR MOT DE PASSE (après clic lien email)
// ============================================================
async function hcUpdatePassword(newPassword) {
  const sb = getSupabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  return true;
}

// ============================================================
// INVITATIONS — PME Admin invite un expert ou collaborateur
// CdC V3 : Table invitations, token 7 jours
// ============================================================
async function hcEnvoyerInvitation({ email, role }) {
  const session = JSON.parse(sessionStorage.getItem('hc_session') || '{}');
  if (session.role !== 'PME') throw new Error('Seul le PME Admin peut inviter.');

  const rolesValides = ['EXPERT', 'COLLABORATEUR'];
  if (!rolesValides.includes(role)) throw new Error('Rôle invalide.');

  const sb = getSupabase();

  // Vérifier la limite (max 3 invités : 1 expert + 2 collabs)
  const { count } = await sb.from('invitations')
    .select('*', { count: 'exact', head: true })
    .eq('pme_id', session.pmeId)
    .eq('statut', 'Acceptée');

  if (count >= 3) throw new Error('Maximum 3 invités par PME.');

  // Créer l'invitation (token auto-généré par la table)
  const { data: inv, error } = await sb.from('invitations').insert({
    pme_id:      session.pmeId,
    email_invite: email,
    role_invite:  role
  }).select().single();

  if (error) throw new Error('Erreur invitation: ' + error.message);

  // Générer le lien d'invitation à partager
  const inviteUrl = window.location.origin + '/accept-invite.html?token=' + inv.token;
  inv.invite_url = inviteUrl;

  return inv;
}

// ============================================================
// ACCEPTER UNE INVITATION (page accept-invite.html?token=xxx)
// ============================================================
async function hcAccepterInvitation({ token, email, password, nom }) {
  const sb = getSupabase();

  // 1. Vérifier le token (via service_role — ici on fait un select public si RLS le permet)
  const { data: inv, error: invErr } = await sb.from('invitations')
    .select('*')
    .eq('token', token)
    .eq('statut', 'En attente')
    .gt('expires_at', new Date().toISOString())
    .single();

  if (invErr || !inv) throw new Error('Invitation invalide ou expirée.');

  // 2. Créer le compte Supabase Auth
  const { data: authData, error: authErr } = await sb.auth.signUp({
    email: inv.email_invite,
    password,
    options: {
      data: {
        role: inv.role_invite,
        nom,
        pme_id: inv.pme_id
      }
    }
  });
  if (authErr) throw new Error(authErr.message);

  // 3. Si EXPERT : créer entrée cabinet
  if (inv.role_invite === 'EXPERT') {
    // Mettre à jour pme_liste.email_expert
    await sb.from('pme_liste')
      .update({ email_expert: inv.email_invite })
      .eq('id', inv.pme_id);
  }

  // 4. Si COLLABORATEUR : créer entrée collaborateurs + maj pme_liste
  if (inv.role_invite === 'COLLABORATEUR') {
    await sb.from('collaborateurs').insert({
      pme_id: inv.pme_id,
      email:  inv.email_invite,
      role:   'COLLABORATEUR'
    });

    // FIX #1.3 : Mettre à jour email_collab1 ou email_collab2 dans pme_liste
    const { data: pme } = await sb.from('pme_liste')
      .select('email_collab1, email_collab2')
      .eq('id', inv.pme_id)
      .single();

    if (pme) {
      if (!pme.email_collab1) {
        await sb.from('pme_liste').update({ email_collab1: inv.email_invite }).eq('id', inv.pme_id);
      } else if (!pme.email_collab2) {
        await sb.from('pme_liste').update({ email_collab2: inv.email_invite }).eq('id', inv.pme_id);
      }
    }
  }

  // 5. Marquer invitation comme acceptée
  await sb.from('invitations')
    .update({ statut: 'Acceptée' })
    .eq('id', inv.id);

  return { pmeId: inv.pme_id, role: inv.role_invite };
}

// ============================================================
// PERMISSIONS — Qui peut faire quoi
// CdC V3 Section 4.1 : matrice de droits
// ============================================================
const PERMISSIONS = {
  PME:            ['import', 'validation', 'correction', 'export', 'invitations', 'read', 'tva'],
  EXPERT:         ['validation', 'correction', 'export', 'read', 'tva'],
  COLLABORATEUR:  ['read'],
  ADMIN:          ['import', 'validation', 'correction', 'export', 'invitations', 'read', 'tva', 'admin']
};

function hcCanDo(action) {
  const session = JSON.parse(sessionStorage.getItem('hc_session') || '{}');
  if (!session.role) return false;
  return PERMISSIONS[session.role]?.includes(action) ?? false;
}

// ============================================================
// GUARD — Vérifier auth, rediriger si non connecté
// ============================================================
function hcRequireAuth() {
  const raw = sessionStorage.getItem('hc_session');
  if (!raw) {
    window.location.href = 'login.html';
    return null;
  }
  return JSON.parse(raw);
}

// Vérifier que le rôle correspond à la page
function hcRequireRole(expectedRole) {
  const session = hcRequireAuth();
  if (!session) return null;
  if (session.role !== expectedRole && session.role !== 'ADMIN') {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

// ============================================================
// REDIRECT PAR RÔLE — Après connexion réussie
// CdC V3 Section 4.2 : lecture du rôle → redirect bon dashboard
// ============================================================
function hcRedirectByRole(role) {
  switch (role) {
    case 'EXPERT':
      window.location.href = 'dashboard-expert.html';
      break;
    case 'ADMIN':
      window.location.href = 'dashboard-expert.html'; // Admin utilise le dashboard expert
      break;
    case 'PME':
    case 'COLLABORATEUR':
    default:
      window.location.href = 'dashboard-pme.html';
      break;
  }
}

// ============================================================
// LISTENER — Détection auto déconnexion / expiration
// CdC V3 : onAuthStateChange pour déconnexion automatique
// ============================================================
function hcInitAuthListener() {
  const sb = getSupabase();
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' && !session) {
      sessionStorage.removeItem('hc_session');
      window.location.href = 'login.html';
    }
  });
}

// ============================================================
// HELPER — JWT pour appels proxy/Edge Function
// ============================================================
async function hcGetJWT() {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token ?? null;
}

// ============================================================
// SHA256 — Audit trail hash (Web Crypto API)
// ============================================================
async function _sha256(data) {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// LOG SESSION — Audit sécurité (table sessions_log)
// ============================================================
async function _logSession(userId, pmeId, role) {
  if (!userId) return;
  const sb = getSupabase();
  try {
    const hashInput = [userId, role, pmeId, new Date().toISOString().slice(0,10)].join('|');
    const sessionHash = await _sha256(hashInput);
    await sb.from('sessions_log').insert({
      user_id: userId,
      pme_id:  pmeId,
      role,
      session_hash: sessionHash
    });
  } catch (e) {
    // Silencieux — le log ne doit pas bloquer la connexion
    console.warn('[SESSION LOG]', e.message);
  }
}

// ============================================================
// EXPORTS GLOBAUX — Utilisables depuis les HTML
// ============================================================
window.HC = {
  // Auth
  inscription:       hcInscription,
  connexion:         hcConnexion,
  deconnexion:       hcDeconnexion,
  getSession:        hcGetSession,
  resetPassword:     hcResetPassword,
  updatePassword:    hcUpdatePassword,

  // Invitations
  envoyerInvitation: hcEnvoyerInvitation,
  accepterInvitation: hcAccepterInvitation,

  // Permissions
  canDo:             hcCanDo,
  requireAuth:       hcRequireAuth,
  requireRole:       hcRequireRole,
  redirectByRole:    hcRedirectByRole,

  // Listener
  initAuthListener:  hcInitAuthListener,

  // Helpers
  getJWT:            hcGetJWT,
  getSupabase:       getSupabase
};
