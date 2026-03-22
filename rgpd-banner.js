// H-Compta AI — Bannière RGPD / Protection des données
// Conforme RGPD (UE) + Loi n°2013-450 CI + Loi n°2010/012 CM + Loi n°2008-12 SN
// Adapté SaaS comptabilité — données financières sensibles
(function() {
  if (localStorage.getItem('hc_rgpd_consent')) return;

  var css = document.createElement('style');
  css.textContent = [
    '#hc-rgpd{position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#111827;border-top:1px solid #1e2d45;padding:20px 24px;display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;font-family:Inter,sans-serif;animation:hcSlideUp .4s ease}',
    '@keyframes hcSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}',
    '#hc-rgpd .hc-r-icon{font-size:28px;flex-shrink:0;margin-top:2px}',
    '#hc-rgpd .hc-r-text{flex:1;min-width:280px}',
    '#hc-rgpd .hc-r-title{font-size:14px;font-weight:700;color:#e2e8f0;margin-bottom:6px}',
    '#hc-rgpd .hc-r-desc{font-size:12px;color:#94a3b8;line-height:1.6}',
    '#hc-rgpd .hc-r-desc a{color:#1F6FFF;text-decoration:underline}',
    '#hc-rgpd .hc-r-btns{display:flex;gap:10px;flex-shrink:0;align-items:center;flex-wrap:wrap}',
    '#hc-rgpd .hc-r-btn{padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:opacity .2s}',
    '#hc-rgpd .hc-r-accept{background:linear-gradient(135deg,#059669,#10b981);color:#fff}',
    '#hc-rgpd .hc-r-decline{background:transparent;color:#94a3b8;border:1px solid #1e2d45}',
    '#hc-rgpd .hc-r-btn:hover{opacity:.85}',
    '@media(max-width:640px){#hc-rgpd{flex-direction:column}#hc-rgpd .hc-r-btns{width:100%}#hc-rgpd .hc-r-btn{flex:1}}'
  ].join('');
  document.head.appendChild(css);

  var banner = document.createElement('div');
  banner.id = 'hc-rgpd';
  banner.innerHTML = [
    '<div class="hc-r-icon">\uD83D\uDD12</div>',
    '<div class="hc-r-text">',
    '  <div class="hc-r-title">Protection de vos donn\u00e9es</div>',
    '  <div class="hc-r-desc">',
    '    H-Compta AI traite des donn\u00e9es comptables et financi\u00e8res sensibles. ',
    '    Vos donn\u00e9es sont stock\u00e9es de mani\u00e8re s\u00e9curis\u00e9e (chiffrement, isolation par entreprise) ',
    '    et ne sont jamais partag\u00e9es avec des tiers. ',
    '    Conforme au <strong style="color:#e2e8f0">RGPD</strong> (UE), \u00e0 la ',
    '    <strong style="color:#e2e8f0">Loi n\u00b02013-450</strong> (C\u00f4te d\'Ivoire), ',
    '    <strong style="color:#e2e8f0">Loi n\u00b02010/012</strong> (Cameroun) et ',
    '    <strong style="color:#e2e8f0">Loi n\u00b02008-12</strong> (S\u00e9n\u00e9gal). ',
    '    Dur\u00e9e de conservation : 10 ans (obligation comptable SYSCOHADA). ',
    '    <a href="#" onclick="alert(\'Contact DPO : dpo@hcompta.ai\');return false">En savoir plus</a>',
    '  </div>',
    '</div>',
    '<div class="hc-r-btns">',
    '  <button class="hc-r-btn hc-r-accept" onclick="hcRgpdAccept()">J\'accepte</button>',
    '  <button class="hc-r-btn hc-r-decline" onclick="hcRgpdDecline()">Refuser</button>',
    '</div>'
  ].join('');
  document.body.appendChild(banner);

  window.hcRgpdAccept = function() {
    localStorage.setItem('hc_rgpd_consent', JSON.stringify({
      accepted: true,
      date: new Date().toISOString(),
      version: '1.0'
    }));
    document.getElementById('hc-rgpd').remove();
  };

  window.hcRgpdDecline = function() {
    localStorage.setItem('hc_rgpd_consent', JSON.stringify({
      accepted: false,
      date: new Date().toISOString(),
      version: '1.0'
    }));
    document.getElementById('hc-rgpd').remove();
  };
})();
