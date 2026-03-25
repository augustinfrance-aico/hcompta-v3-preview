-- ============================================================
-- H-COMPTA AI — Schema V3 (CdC V3 Supabase — Source de vérité)
-- 8 tables · RLS · 5 buckets · Fonctions helper · Index
-- Auteur : Cooper Building | Date : 2026-03-18
--
-- RÈGLE : chaque colonne, chaque type, chaque contrainte
-- correspond EXACTEMENT au CdC V3 de Noé (docx).
-- ============================================================

-- Extension UUID (nécessaire pour gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLE 1 : pme_liste
-- Source CdC V3 : Section 3, Table 1
-- Une ligne par PME cliente
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pme_liste (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom_pme           text        NOT NULL,
  email_acces       text        UNIQUE NOT NULL,
  email_expert      text,
  email_collab1     text,
  email_collab2     text,
  pays              text        NOT NULL CHECK (pays IN ('CI', 'CM', 'SN')),
  tva_taux          numeric     DEFAULT 18,
  statut            text        DEFAULT 'Prospect' CHECK (statut IN ('Prospect', 'Actif', 'Suspendu')),
  code_ambassadeur  text,
  score_conformite  integer     DEFAULT 0 CHECK (score_conformite >= 0 AND score_conformite <= 100),
  plan              text        DEFAULT 'TPE' CHECK (plan IN ('TPE', 'PME', 'Expert')),
  date_inscription  timestamptz DEFAULT now(),
  created_at        timestamptz DEFAULT now()
);

COMMENT ON TABLE public.pme_liste IS 'CdC V3 Table 1 — Une ligne par PME cliente (CI/CM/SN)';

-- ============================================================
-- TABLE 2 : ecritures
-- Source CdC V3 : Section 3, Table 2
-- Pièces comptables traitées par Mariah
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ecritures (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pme_id              uuid        NOT NULL REFERENCES public.pme_liste(id) ON DELETE CASCADE,
  fournisseur         text,
  montant_ht          numeric,
  tva                 numeric,
  montant_ttc         numeric,
  compte_debit        text,       -- Code SYSCOHADA 6 chiffres (ex: 626200)
  compte_credit       text,       -- Code SYSCOHADA 6 chiffres (ex: 401000)
  journal             text CHECK (journal IN ('ACH', 'VTE', 'BQ', 'CAI', 'OD', 'IMM', 'PAI')),
  description         text,
  statut              text        DEFAULT 'En attente' CHECK (statut IN ('En attente', 'À valider', 'Validé', 'Rejeté')),
  fichier_source      text,       -- Chemin dans Supabase Storage
  prompt_version      text,       -- Version du prompt Mariah utilisé
  expert_validateur   uuid        REFERENCES auth.users(id),
  date_validation     timestamptz,
  commentaire         text,
  created_at          timestamptz DEFAULT now()
);

COMMENT ON TABLE public.ecritures IS 'CdC V3 Table 2 — Écritures comptables SYSCOHADA traitées par Mariah';

-- ============================================================
-- TABLE 3 : prompts ⭐ Table stratégique
-- Source CdC V3 : Section 3, Table 3
-- RÈGLE ABSOLUE : les prompts Mariah vivent ICI, jamais dans le code
-- ============================================================
CREATE TABLE IF NOT EXISTS public.prompts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id       text        UNIQUE NOT NULL,  -- Ex: PME-01, MAR-01
  nom_prompt      text        NOT NULL,         -- Ex: Analyse Facture Achat CI
  type_document   text        NOT NULL CHECK (type_document IN (
    'FACTURE_ACHAT', 'FACTURE_VENTE', 'RELEVE_BANCAIRE',
    'RECU_DE_CAISSE', 'BULLETIN_DE_PAIE'
  )),
  pays            text        NOT NULL CHECK (pays IN ('CI', 'CM', 'SN', 'TOUS')),
  texte_prompt    text        NOT NULL,         -- Texte complet (peut faire 2000+ chars)
  actif           boolean     DEFAULT true,
  version         text,                         -- Ex: v2.1
  date_modif      timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.prompts IS 'CdC V3 Table 3 — Bibliothèque prompts Mariah. JAMAIS dans le code.';

-- ============================================================
-- TABLE 4 : ambassadeurs
-- Source CdC V3 : Section 3, Tables 4 à 8
-- Programme parrainage — codes promo + commissions
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ambassadeurs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom             text        NOT NULL,
  email           text        UNIQUE NOT NULL,
  code_promo      text        UNIQUE NOT NULL,
  commission_pct  numeric     DEFAULT 10 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  nb_referrals    integer     DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.ambassadeurs IS 'CdC V3 Table 4 — Programme ambassadeurs, codes promo, commissions';

-- ============================================================
-- TABLE 5 : invitations
-- Source CdC V3 : Section 3, Tables 4 à 8
-- Invitations Expert / Collaborateurs — tokens d'activation
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invitations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pme_id          uuid        NOT NULL REFERENCES public.pme_liste(id) ON DELETE CASCADE,
  email_invite    text        NOT NULL,
  role_invite     text        NOT NULL CHECK (role_invite IN ('EXPERT', 'COLLABORATEUR')),
  token           text        UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  statut          text        DEFAULT 'En attente' CHECK (statut IN ('En attente', 'Acceptée', 'Rejetée', 'Expirée')),
  expires_at      timestamptz DEFAULT (now() + interval '7 days'),
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.invitations IS 'CdC V3 Table 5 — Invitations Expert/Collaborateur avec token 7 jours';

-- ============================================================
-- TABLE 6 : cabinets
-- Source CdC V3 : Section 3, Tables 4 à 8
-- Cabinets d'expertise comptable gérant plusieurs PME
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cabinets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom_cabinet     text        NOT NULL,
  email_expert    text        UNIQUE NOT NULL,
  pays            text        NOT NULL CHECK (pays IN ('CI', 'CM', 'SN')),
  nb_pme          integer     DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.cabinets IS 'CdC V3 Table 6 — Cabinets expertise comptable, portefeuille N PMEs';

-- ============================================================
-- TABLE 7 : collaborateurs
-- Source CdC V3 : Section 3, Tables 4 à 8
-- Collaborateurs internes d'une PME (accès limité)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.collaborateurs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pme_id          uuid        NOT NULL REFERENCES public.pme_liste(id) ON DELETE CASCADE,
  email           text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('COLLABORATEUR')),
  statut          text        DEFAULT 'Actif' CHECK (statut IN ('Actif', 'Inactif')),
  created_at      timestamptz DEFAULT now(),
  UNIQUE(pme_id, email)
);

COMMENT ON TABLE public.collaborateurs IS 'CdC V3 Table 7 — Collaborateurs internes PME, accès lecture seule';

-- ============================================================
-- TABLE 8 : sessions_log
-- Source CdC V3 : Section 3, Tables 4 à 8
-- Journal des connexions — audit de sécurité
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sessions_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id),
  pme_id          uuid        REFERENCES public.pme_liste(id),
  role            text        NOT NULL,
  ip              text,
  session_hash    text,
  created_at      timestamptz DEFAULT now(),
  expires_at      timestamptz
);

COMMENT ON TABLE public.sessions_log IS 'CdC V3 Table 8 — Journal connexions, audit sécurité';


-- ============================================================
-- ROW LEVEL SECURITY (RLS) — OBLIGATOIRE sur les 8 tables
-- Source CdC V3 : Section 4.2 "Point d'attention — RLS"
-- "Un utilisateur PME ne peut voir que les écritures où
--  pme_id = son propre id"
-- ============================================================

-- Activer RLS sur TOUTES les tables
ALTER TABLE public.pme_liste      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ecritures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ambassadeurs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabinets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaborateurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions_log   ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FONCTIONS HELPER — sécurité DEFINER
-- Source CdC V3 : "get_user_pme_id()" et "get_user_role()"
-- ============================================================

-- Récupérer le rôle depuis les metadata JWT Supabase
-- CdC V3 Section 4.1 : rôle stocké dans user_metadata
-- FIX #6/#14 : PL/pgSQL pour distinguer anon vs auth vs erreur
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text AS $$
BEGIN
  IF auth.jwt() IS NULL THEN
    RETURN 'ANONYMOUS';
  END IF;
  RETURN COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'role')::text,
    'AUTHENTICATED'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Récupérer le pme_id de l'utilisateur connecté
-- Cherche dans pme_liste (PME) OU collaborateurs (COLLABORATEUR)
CREATE OR REPLACE FUNCTION public.get_user_pme_id()
RETURNS uuid AS $$
  SELECT COALESCE(
    (SELECT id FROM public.pme_liste WHERE email_acces = auth.jwt() ->> 'email' LIMIT 1),
    (SELECT pme_id FROM public.collaborateurs WHERE email = auth.jwt() ->> 'email' AND statut = 'Actif' LIMIT 1)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Récupérer le cabinet_id pour les experts
CREATE OR REPLACE FUNCTION public.get_user_cabinet_id()
RETURNS uuid AS $$
  SELECT id FROM public.cabinets
  WHERE email_expert = auth.jwt() ->> 'email'
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- RLS POLICIES — pme_liste
-- PME voit sa ligne. Expert voit ses PME (via email_expert).
-- ============================================================

-- PME : voit uniquement sa propre ligne
CREATE POLICY "pme_liste_pme_select" ON public.pme_liste
  FOR SELECT USING (
    email_acces = auth.jwt() ->> 'email'
  );

-- Expert : voit les PME où il est assigné
CREATE POLICY "pme_liste_expert_select" ON public.pme_liste
  FOR SELECT USING (
    email_expert = auth.jwt() ->> 'email'
  );

-- Admin : voit tout
CREATE POLICY "pme_liste_admin_all" ON public.pme_liste
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
  );

-- Service role (Make.com, Edge Functions) : accès total
CREATE POLICY "pme_liste_service" ON public.pme_liste
  FOR ALL USING (
    auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — ecritures
-- PME voit ses écritures. Expert voit celles de ses PME.
-- ============================================================

CREATE POLICY "ecritures_pme_select" ON public.ecritures
  FOR SELECT USING (
    pme_id = public.get_user_pme_id()
  );

CREATE POLICY "ecritures_expert_select" ON public.ecritures
  FOR SELECT USING (
    pme_id IN (
      SELECT id FROM public.pme_liste
      WHERE email_expert = auth.jwt() ->> 'email'
    )
  );

-- Expert peut UPDATE (valider/rejeter)
CREATE POLICY "ecritures_expert_update" ON public.ecritures
  FOR UPDATE USING (
    pme_id IN (
      SELECT id FROM public.pme_liste
      WHERE email_expert = auth.jwt() ->> 'email'
    )
  );

CREATE POLICY "ecritures_admin_all" ON public.ecritures
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
  );

CREATE POLICY "ecritures_service" ON public.ecritures
  FOR ALL USING (
    auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — prompts
-- Lecture pour tous les connectés (Make a besoin de lire)
-- Écriture réservée admin + service_role
-- ============================================================

-- FIX #7 : Restreindre à authenticated (pas anon)
CREATE POLICY "prompts_read_all" ON public.prompts
  FOR SELECT USING (
    auth.role() IN ('authenticated', 'service_role')
  );

CREATE POLICY "prompts_admin_write" ON public.prompts
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — ambassadeurs
-- Lecture tous connectés. Écriture admin + service.
-- ============================================================

-- FIX #8 : Restreindre à authenticated (pas anon)
CREATE POLICY "ambassadeurs_read_all" ON public.ambassadeurs
  FOR SELECT USING (
    auth.role() IN ('authenticated', 'service_role')
  );

CREATE POLICY "ambassadeurs_admin_write" ON public.ambassadeurs
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — invitations
-- PME admin voit ses invitations envoyées.
-- Invité peut lire par token (via service_role dans le flow).
-- ============================================================

CREATE POLICY "invitations_pme_select" ON public.invitations
  FOR SELECT USING (
    pme_id = public.get_user_pme_id()
  );

CREATE POLICY "invitations_pme_insert" ON public.invitations
  FOR INSERT WITH CHECK (
    pme_id = public.get_user_pme_id()
  );

-- FIX #1.4 : Permettre la lecture par token pour les nouveaux invités
-- (le service_role gère ce flow via Edge Function, mais backup RLS)
CREATE POLICY "invitations_read_by_token" ON public.invitations
  FOR SELECT USING (
    auth.role() IN ('authenticated', 'service_role')
  );

CREATE POLICY "invitations_admin_all" ON public.invitations
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — cabinets
-- Expert voit son cabinet. Admin voit tout.
-- ============================================================

CREATE POLICY "cabinets_expert_select" ON public.cabinets
  FOR SELECT USING (
    email_expert = auth.jwt() ->> 'email'
  );

CREATE POLICY "cabinets_admin_all" ON public.cabinets
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — collaborateurs
-- Collaborateur voit son entrée. PME admin voit ses collabs.
-- ============================================================

CREATE POLICY "collaborateurs_own_select" ON public.collaborateurs
  FOR SELECT USING (
    email = auth.jwt() ->> 'email'
  );

CREATE POLICY "collaborateurs_pme_select" ON public.collaborateurs
  FOR SELECT USING (
    pme_id = public.get_user_pme_id()
  );

CREATE POLICY "collaborateurs_pme_manage" ON public.collaborateurs
  FOR ALL USING (
    pme_id = public.get_user_pme_id()
    AND public.get_user_role() = 'PME'
  );

CREATE POLICY "collaborateurs_admin_all" ON public.collaborateurs
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- RLS POLICIES — sessions_log
-- User voit ses propres sessions. Admin voit tout.
-- ============================================================

CREATE POLICY "sessions_log_own_select" ON public.sessions_log
  FOR SELECT USING (
    user_id = auth.uid()
  );

-- Insert autorisé pour tout utilisateur connecté (logging)
CREATE POLICY "sessions_log_insert" ON public.sessions_log
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
  );

CREATE POLICY "sessions_log_admin_all" ON public.sessions_log
  FOR ALL USING (
    public.get_user_role() = 'ADMIN'
    OR auth.role() = 'service_role'
  );


-- ============================================================
-- SUPABASE STORAGE — 5 Buckets
-- Source CdC V3 : Section 5.1
-- Convention : {bucket}/{pme_id}/{annee}/{mois}/{timestamp}_{nom}.ext
-- ============================================================

-- NOTE : storage.foldername() est native dans Supabase (pas besoin de la créer)
-- On utilise split_part() comme alternative plus compatible

-- Création des 5 buckets
INSERT INTO storage.buckets (id, name, public) VALUES
  ('factures-brutes',   'factures-brutes',   false),
  ('factures-traitees', 'factures-traitees', false),
  ('exports',           'exports',           false),
  ('tva',               'tva',               false),
  ('templates',         'templates',         false)
ON CONFLICT (id) DO NOTHING;

-- Policies Storage — factures-brutes : PME propriétaire uniquement
CREATE POLICY "factures_brutes_pme_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'factures-brutes'
    AND split_part(name, '/', 1) = public.get_user_pme_id()::text
  );

CREATE POLICY "factures_brutes_pme_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'factures-brutes'
    AND split_part(name, '/', 1) = public.get_user_pme_id()::text
  );

-- factures-traitees : PME + Expert assigné
CREATE POLICY "factures_traitees_pme_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'factures-traitees'
    AND (
      split_part(name, '/', 1) = public.get_user_pme_id()::text
      OR split_part(name, '/', 1) IN (
        SELECT id::text FROM public.pme_liste
        WHERE email_expert = auth.jwt() ->> 'email'
      )
    )
  );

-- exports : PME + Expert assigné
CREATE POLICY "exports_pme_expert_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'exports'
    AND (
      split_part(name, '/', 1) = public.get_user_pme_id()::text
      OR split_part(name, '/', 1) IN (
        SELECT id::text FROM public.pme_liste
        WHERE email_expert = auth.jwt() ->> 'email'
      )
    )
  );

-- tva : PME + Expert assigné
CREATE POLICY "tva_pme_expert_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'tva'
    AND (
      split_part(name, '/', 1) = public.get_user_pme_id()::text
      OR split_part(name, '/', 1) IN (
        SELECT id::text FROM public.pme_liste
        WHERE email_expert = auth.jwt() ->> 'email'
      )
    )
  );

-- FIX #9 : templates = connectés uniquement (pas anon)
CREATE POLICY "templates_read_all" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'templates'
    AND auth.role() IN ('authenticated', 'service_role')
  );

-- FIX #10 : DELETE policies pour que les PME puissent nettoyer leurs fichiers
CREATE POLICY "factures_brutes_pme_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'factures-brutes'
    AND split_part(name, '/', 1) = public.get_user_pme_id()::text
  );

-- Service role : accès total tous buckets (pour Make.com / Edge Functions)
CREATE POLICY "storage_service_all" ON storage.objects
  FOR ALL USING (
    auth.role() = 'service_role'
  );


-- ============================================================
-- INDEX — Performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_ecritures_pme_id      ON public.ecritures(pme_id);
CREATE INDEX IF NOT EXISTS idx_ecritures_statut       ON public.ecritures(statut);
CREATE INDEX IF NOT EXISTS idx_ecritures_created_at   ON public.ecritures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pme_liste_email_acces  ON public.pme_liste(email_acces);
CREATE INDEX IF NOT EXISTS idx_pme_liste_email_expert ON public.pme_liste(email_expert);
CREATE INDEX IF NOT EXISTS idx_pme_liste_pays         ON public.pme_liste(pays);
CREATE INDEX IF NOT EXISTS idx_prompts_type_pays      ON public.prompts(type_document, pays, actif);
CREATE INDEX IF NOT EXISTS idx_invitations_token      ON public.invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_pme_id     ON public.invitations(pme_id);
CREATE INDEX IF NOT EXISTS idx_cabinets_email_expert  ON public.cabinets(email_expert);
CREATE INDEX IF NOT EXISTS idx_collaborateurs_pme_id  ON public.collaborateurs(pme_id);
CREATE INDEX IF NOT EXISTS idx_collaborateurs_email   ON public.collaborateurs(email);
CREATE INDEX IF NOT EXISTS idx_sessions_log_user_id   ON public.sessions_log(user_id);


-- ============================================================
-- DONNÉES SEED — 5 PME test + 1 cabinet + 1 ambassadeur
-- Source CdC V3 : "5 PME de démo minimum"
-- ============================================================

-- 5 PME fictives (CI, CM, SN)
INSERT INTO public.pme_liste (nom_pme, email_acces, pays, tva_taux, statut, plan) VALUES
  ('CimenCI SA',       'pme@test.ci',      'CI', 18,    'Actif', 'PME'),
  ('BatiPlusCi',       'batiplus@test.ci',  'CI', 18,    'Actif', 'TPE'),
  ('AgroCôte SA',      'agrocote@test.cm',  'CM', 19.25, 'Actif', 'PME'),
  ('ImmoCôte',         'immocote@test.ci',  'CI', 18,    'Actif', 'Expert'),
  ('MétalCI',          'metalci@test.sn',   'SN', 18,    'Actif', 'TPE')
ON CONFLICT (email_acces) DO NOTHING;

-- Assigner un expert aux 3 premières PME
UPDATE public.pme_liste SET email_expert = 'expert@test.ci'
WHERE email_acces IN ('pme@test.ci', 'batiplus@test.ci', 'agrocote@test.cm');

-- 1 cabinet expert
INSERT INTO public.cabinets (nom_cabinet, email_expert, pays, nb_pme) VALUES
  ('Cabinet Kouassi & Associés', 'expert@test.ci', 'CI', 3)
ON CONFLICT (email_expert) DO NOTHING;

-- 1 ambassadeur test
INSERT INTO public.ambassadeurs (nom, email, code_promo, commission_pct) VALUES
  ('Ambassadeur Test', 'ambassadeur@test.ci', 'TEST2026', 10)
ON CONFLICT (email) DO NOTHING;


-- ============================================================
-- FIN DU SCHEMA V3
-- Vérification : 8 tables · RLS sur 8 · 5 buckets · 13 index
-- Aligné CdC V3 section par section
-- ============================================================
