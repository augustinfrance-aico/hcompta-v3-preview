/**
 * H-COMPTA AI — Dashboard Bridge V3
 * Connecte les 2 dashboards (PME + Expert) à Supabase directement
 *
 * Remplace : proxy Airtable/Dropbox
 * Par :      SDK Supabase JS direct + Edge Function pour Mariah
 *
 * Injecter APRÈS auth_v3.js :
 *   <script src="auth_v3.js"></script>
 *   <script src="bridge_v3.js"></script>
 *   <script>document.addEventListener('DOMContentLoaded', hcDashboardInit);</script>
 *
 * Source de vérité : CdC V3 Sections 3-6
 */

// ============================================================
// CONFIG
// ============================================================
// FIX #3.2 : Vérifier que SUPABASE_URL est défini (auth_v3.js doit être chargé avant)
const PROXY_URL = (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : 'https://auxhvovqrevwhkpmpwrc.supabase.co') + '/functions/v1/proxy';
let _session = null;
let _refreshInterval = null;
let _realtimeChannel = null;  // FIX #3.9 : Garder une ref pour cleanup

// ============================================================
// BOOT — Appelé au DOMContentLoaded
// ============================================================
async function hcDashboardInit() {
  // 1. Vérifier la session
  _session = HC.requireAuth();
  if (!_session) return;

  // 2. Rafraîchir la session depuis Supabase (pas juste sessionStorage)
  _session = await HC.getSession();
  if (!_session) {
    window.location.href = 'login.html';
    return;
  }

  // 3. Injecter les infos dans le DOM
  _injectSessionUI();

  // 4. Masquer/afficher selon le rôle
  _applyRoleGuards();

  // 5. Charger les données
  await hcLoadAll();

  // 6. Écouter les changements en temps réel
  _initRealtime();

  // 7. Refresh toutes les 30 secondes
  _refreshInterval = setInterval(hcLoadAll, 30000);

  // 8. Écouter déconnexion auto
  HC.initAuthListener();
}

// ============================================================
// CHARGER TOUT — KPIs + Tableau écritures
// ============================================================
async function hcLoadAll() {
  await Promise.all([hcLoadKPIs(), hcLoadEcritures()]);
}

// ============================================================
// KPIs — Dashboard PME
// CdC V3 : COUNT ecritures, SUM montant_ttc, COUNT Auto, COUNT À valider
// ============================================================
async function hcLoadKPIs() {
  const sb = HC.getSupabase();
  const pmeId = _session.pmeId;
  if (!pmeId) return;

  try {
    // Toutes les écritures de cette PME
    const { data: ecritures, error } = await sb.from('ecritures')
      .select('montant_ttc, statut')
      .eq('pme_id', pmeId);

    if (error) throw error;

    const kpis = {
      total:     ecritures?.length || 0,
      montant:   ecritures?.reduce((s, e) => s + (parseFloat(e.montant_ttc) || 0), 0) || 0,
      auto:      ecritures?.filter(e => e.statut === 'Validé').length || 0,
      aValider:  ecritures?.filter(e => e.statut === 'À valider').length || 0
    };

    // Injecter dans le DOM (IDs du Dashboard PME V5 de Noé)
    _setEl('kpi-nb', kpis.total);
    _setEl('kpi-av', kpis.aValider);
    _setEl('kpi-ia', kpis.total > 0 ? Math.round((kpis.auto / kpis.total) * 100) + '%' : '0%');
    _setEl('kpi-tva', _formatCurrency(kpis.montant * (_session.tva / 100 || 0.18), _session.pays));

  } catch (e) {
    console.error('[KPI ERROR]', e);
  }
}

// ============================================================
// TABLEAU ÉCRITURES — Données dynamiques
// ============================================================
async function hcLoadEcritures() {
  const sb = HC.getSupabase();
  const pmeId = _session.pmeId;
  if (!pmeId) return;

  try {
    const { data: ecritures, error } = await sb.from('ecritures')
      .select('*')
      .eq('pme_id', pmeId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    _renderEcrituresTable(ecritures || []);
  } catch (e) {
    console.error('[ECRITURES ERROR]', e);
  }
}

function _renderEcrituresTable(ecritures) {
  const tbody = document.getElementById('tbl-body') || document.getElementById('hc-pieces-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!ecritures.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#999">Aucune écriture</td></tr>';
    return;
  }

  ecritures.forEach((e, i) => {
    const row = document.createElement('tr');
    row.dataset.id = e.id;
    row.innerHTML = `
      <td>${_formatDate(e.created_at)}</td>
      <td>${e.fournisseur || '—'}</td>
      <td>${_formatCurrency(e.montant_ttc, _session.pays)}</td>
      <td>${e.journal || '—'}</td>
      <td>${e.compte_debit || '—'}</td>
      <td>${_statutBadge(e.statut)}</td>
      <td>
        ${HC.canDo('validation') && e.statut === 'À valider' ? `<button class="hc-btn hc-btn-sm" onclick="hcValider('${e.id}')">Valider</button>` : ''}
      </td>
    `;
    tbody.appendChild(row);
  });
}

// ============================================================
// VALIDER / REJETER — Via Edge Function proxy
// CdC V3 Condition recette n°2 + Guide Make V2 S8
// ============================================================
async function hcValider(ecritureId) {
  if (!HC.canDo('validation')) return;
  try {
    const jwt = await HC.getJWT();
    const resp = await fetch(PROXY_URL + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({ ecritureId, action: 'valider' })
    });
    if (!resp.ok) throw new Error(await resp.text());
    _showToast('Écriture validée');
    await hcLoadAll();
  } catch (e) {
    console.error('[VALIDER ERROR]', e);
  }
}

async function hcRejeter(ecritureId, commentaire) {
  if (!HC.canDo('validation')) return;
  try {
    const jwt = await HC.getJWT();
    const resp = await fetch(PROXY_URL + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({ ecritureId, action: 'rejeter', commentaire })
    });
    if (!resp.ok) throw new Error(await resp.text());
    _showToast('Écriture rejetée');
    await hcLoadAll();
  } catch (e) {
    console.error('[REJETER ERROR]', e);
  }
}

// ============================================================
// IMPORT FACTURE — Upload vers Supabase Storage
// CdC V3 Section 5.3 : supabase.storage.from('factures-brutes').upload()
// ============================================================
async function hcImporterPiece(file) {
  if (!HC.canDo('import')) return alert('Permissions insuffisantes');
  if (!file) return;

  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) return alert('Fichier trop lourd (max 10 Mo)');

  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowed.includes(file.type)) return alert('Format non supporté (PDF, JPG, PNG)');

  _showToast('Upload en cours...');

  try {
    const sb = HC.getSupabase();
    const pmeId = _session.pmeId;
    const now = Date.now();
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');

    // Convention CdC V3 : {bucket}/{pme_id}/{annee}/{mois}/{timestamp}_{nom}
    const path = `${pmeId}/${year}/${month}/${now}_${file.name}`;

    const { error: uploadErr } = await sb.storage
      .from('factures-brutes')
      .upload(path, file);

    if (uploadErr) throw uploadErr;

    // Créer une écriture en statut "En attente" pour que Make S2 la détecte
    const { error: insertErr } = await sb.from('ecritures').insert({
      pme_id:         pmeId,
      statut:         'En attente',
      fichier_source: path,  // FIX #3.5 : pas de double préfixe bucket
      fournisseur:    file.name.replace(/\.[^.]+$/, '')
    });

    if (insertErr) throw insertErr;

    _showToast('Facture importée — analyse Mariah en cours...');
    await hcLoadAll();

  } catch (e) {
    alert('Erreur import : ' + e.message);
  }
}

// ============================================================
// EXPORT SAGE / ODOO — Déclencher via proxy → Make S3
// ============================================================
async function hcExport(format) {
  if (!HC.canDo('export')) return;
  try {
    const jwt = await HC.getJWT();
    const resp = await fetch(PROXY_URL + '/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({
        pmeId: _session.pmeId,
        format: format || 'sage'
      })
    });
    if (!resp.ok) throw new Error(await resp.text());
    _showToast('Export ' + (format || 'Sage') + ' lancé — fichier bientôt disponible');
  } catch (e) {
    console.error('[EXPORT ERROR]', e);
  }
}

// ============================================================
// LISTER FICHIERS STORAGE — Exports Sage, TVA
// ============================================================
async function hcLoadExportSage() {
  const sb = HC.getSupabase();
  const pmeId = _session.pmeId;

  try {
    const { data: files } = await sb.storage
      .from('exports')
      .list(pmeId + '/sage', { limit: 20, sortBy: { column: 'created_at', order: 'desc' } });

    const container = document.getElementById('hc-export-sage-list');
    if (!container) return;
    container.innerHTML = '';

    if (!files?.length) {
      container.innerHTML = '<p style="color:#999">Aucun export disponible</p>';
      return;
    }

    files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'hc-file-row';
      div.innerHTML = `
        <span>${f.name}</span>
        <span style="color:#999;font-size:12px">${_formatBytes(f.metadata?.size || 0)}</span>
        <button class="hc-btn hc-btn-sm" onclick="hcDownloadFile('exports','${pmeId}/sage/${f.name}')">Télécharger</button>
      `;
      container.appendChild(div);
    });
  } catch (e) {
    console.error('[EXPORT SAGE LIST ERROR]', e);
  }
}

async function hcLoadTVA() {
  const sb = HC.getSupabase();
  const pmeId = _session.pmeId;

  try {
    const { data: files } = await sb.storage
      .from('tva')
      .list(pmeId, { limit: 20, sortBy: { column: 'created_at', order: 'desc' } });

    const container = document.getElementById('hc-tva-list');
    if (!container) return;
    container.innerHTML = '';

    if (!files?.length) {
      container.innerHTML = '<p style="color:#999">Aucune déclaration TVA</p>';
      return;
    }

    const tauxTVA = { CI: '18%', CM: '19,25%', SN: '18%' };
    files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'hc-file-row';
      div.innerHTML = `
        <span>${f.name}</span>
        <span class="hc-badge">TVA ${tauxTVA[_session.pays] || ''}</span>
        <button class="hc-btn hc-btn-sm" onclick="hcDownloadFile('tva','${pmeId}/${f.name}')">Télécharger</button>
      `;
      container.appendChild(div);
    });
  } catch (e) {
    console.error('[TVA LIST ERROR]', e);
  }
}

// ============================================================
// TÉLÉCHARGER un fichier Storage
// ============================================================
async function hcDownloadFile(bucket, path) {
  const sb = HC.getSupabase();
  const { data } = await sb.storage.from(bucket).createSignedUrl(path, 60);
  if (data?.signedUrl) window.open(data.signedUrl, '_blank');
}

// ============================================================
// MARIAH — Chat via Edge Function
// ============================================================
async function hcMariahSend(question, history) {
  try {
    const jwt = await HC.getJWT();
    const resp = await fetch(PROXY_URL + '/mariah', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({
        question,
        pmeId: _session.pmeId,
        history: history || []
      })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    return data.reply;
  } catch (e) {
    console.error('[MARIAH ERROR]', e);
    return 'Erreur de connexion à Mariah. Réessayez.';
  }
}

// ============================================================
// INVITATIONS — Panel Abonnement
// ============================================================
async function hcLoadInvitations() {
  if (!HC.canDo('invitations')) return;
  const sb = HC.getSupabase();

  const { data: invitations } = await sb.from('invitations')
    .select('email_invite, role_invite, statut, created_at')
    .eq('pme_id', _session.pmeId);

  const container = document.getElementById('hc-membres-list');
  if (!container) return;
  container.innerHTML = '';

  const roleLabels = { EXPERT: 'Expert Comptable', COLLABORATEUR: 'Collaborateur' };

  (invitations || []).forEach(inv => {
    const div = document.createElement('div');
    div.className = 'hc-member-row';
    div.innerHTML = `
      <span>${inv.email_invite}</span>
      <span class="hc-badge">${roleLabels[inv.role_invite] || inv.role_invite}</span>
      <span style="color:#999;font-size:12px">${inv.statut}</span>
    `;
    container.appendChild(div);
  });

  const restants = 3 - (invitations?.filter(i => i.statut === 'Acceptée').length || 0);
  const slotsEl = document.getElementById('hc-invitations-restantes');
  if (slotsEl) slotsEl.textContent = restants + ' invitation(s) disponible(s)';
}

// ============================================================
// EXPERT — Charger portefeuille PME
// ============================================================
async function hcLoadPortefeuille() {
  if (_session.role !== 'EXPERT' && _session.role !== 'ADMIN') return;
  const sb = HC.getSupabase();

  const { data: pmes } = await sb.from('pme_liste')
    .select('id, nom_pme, pays, score_conformite, statut, plan')
    .eq('email_expert', _session.email);

  return pmes || [];
}

// ============================================================
// REALTIME — Écouter les nouvelles écritures
// CdC V3 L3 : supabase.channel + on('INSERT')
// ============================================================
// FIX #3.9 : Cleanup Realtime avant de recréer + garder la ref
function _initRealtime() {
  const sb = HC.getSupabase();
  const pmeId = _session.pmeId;
  if (!pmeId) return;

  // Cleanup ancien channel si existant
  if (_realtimeChannel) {
    _realtimeChannel.unsubscribe();
    _realtimeChannel = null;
  }

  _realtimeChannel = sb.channel('ecritures-' + pmeId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'ecritures', filter: 'pme_id=eq.' + pmeId },
      (payload) => {
        hcLoadAll();
        _showToast('Nouvelle écriture détectée');
      }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'ecritures', filter: 'pme_id=eq.' + pmeId },
      () => hcLoadAll()
    )
    .subscribe();
}

// Cleanup à appeler avant déconnexion
function hcCleanup() {
  if (_realtimeChannel) {
    _realtimeChannel.unsubscribe();
    _realtimeChannel = null;
  }
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
}

// ============================================================
// UI HELPERS
// ============================================================
function _injectSessionUI() {
  // IDs du Dashboard PME V5 de Noé
  _setEl('sb-name', _session.nomPme || _session.nomCabinet || _session.email);
  _setEl('sb-role', _session.role === 'EXPERT' ? 'Expert · ' + (_session.nomCabinet || '') : _session.role);
  _setEl('hc-nom-pme', _session.nomPme || '');
  _setEl('hc-pme-id', _session.pmeId || '');
  _setEl('hc-user-nom', _session.nomPme || _session.email);
  _setEl('hc-user-role', _session.role);
  _setEl('hc-pays', _session.pays || '');
  _setEl('hc-plan', _session.plan || '');

  // Initiales avatar
  const avEl = document.getElementById('sb-av');
  if (avEl) {
    const name = _session.nomPme || _session.email || '';
    avEl.textContent = name.slice(0, 2).toUpperCase();
  }
}

function _applyRoleGuards() {
  if (!HC.canDo('import')) {
    document.querySelectorAll('[data-hc-require="import"]').forEach(el => el.style.display = 'none');
  }
  if (!HC.canDo('invitations')) {
    document.querySelectorAll('[data-hc-require="invitations"]').forEach(el => el.style.display = 'none');
  }
  if (!HC.canDo('validation')) {
    document.querySelectorAll('[data-hc-require="validation"]').forEach(el => el.style.display = 'none');
  }
}

function _setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function _formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR');
}

function _formatCurrency(amount, pays) {
  const currency = (pays === 'CM') ? 'XAF' : 'XOF';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency', currency, maximumFractionDigits: 0
  }).format(amount || 0);
}

function _formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / 1048576).toFixed(1) + ' Mo';
}

function _statutBadge(statut) {
  const map = {
    'En attente': '<span class="hc-badge" style="background:rgba(148,163,184,.15);color:#94a3b8">En attente</span>',
    'À valider':  '<span class="hc-badge" style="background:rgba(245,158,11,.15);color:#f59e0b">À valider</span>',
    'Validé':     '<span class="hc-badge" style="background:rgba(16,185,129,.15);color:#10b981">Validé</span>',
    'Rejeté':     '<span class="hc-badge" style="background:rgba(239,68,68,.15);color:#ef4444">Rejeté</span>'
  };
  return map[statut] || '<span class="hc-badge">' + (statut || '—') + '</span>';
}

function _showToast(msg) {
  let toast = document.getElementById('toast') || document.getElementById('hc-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'hc-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ============================================================
// EXPORTS GLOBAUX
// ============================================================
window.hcDashboardInit     = hcDashboardInit;
window.hcLoadAll           = hcLoadAll;
window.hcValider           = hcValider;
window.hcRejeter           = hcRejeter;
window.hcImporterPiece     = hcImporterPiece;
window.hcExport            = hcExport;
window.hcLoadExportSage    = hcLoadExportSage;
window.hcLoadTVA           = hcLoadTVA;
window.hcDownloadFile      = hcDownloadFile;
window.hcMariahSend        = hcMariahSend;
window.hcLoadInvitations   = hcLoadInvitations;
window.hcLoadPortefeuille  = hcLoadPortefeuille;
window.hcCleanup           = hcCleanup;
