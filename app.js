(() => {
  'use strict';

  const cfg = window.DMV_CONFIG || {};
  const publicKey = cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_ANON_KEY;
  const isConfigured = Boolean(cfg.SUPABASE_URL && publicKey && !String(publicKey).includes('COLE_AQUI'));
  const clientLib = window.supabase;
  let db = null;
  let currentUser = null;
  let currentProfile = null;
  let generatorsCache = [];

  const $ = (id) => document.getElementById(id);
  const showToast = (message, kind = 'info') => {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast show ${kind}`;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { el.className = 'toast'; }, 4200);
  };
  const friendlyError = (error) => {
    const msg = error?.message || 'Ocorreu um erro inesperado.';
    if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (/failed to fetch/i.test(msg)) return 'Não foi possível conectar. Confira sua internet e a configuração do Supabase.';
    if (/row-level security|permission denied/i.test(msg)) return 'Seu usuário não tem permissão para esta operação.';
    return msg;
  };
  const roleLabel = (role) => ({ administrador: 'Administrador', tecnico: 'Técnico', almoxarifado: 'Almoxarifado' }[role] || 'Usuário');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatNumber = (value, digits = 1) => value == null ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
  const formatDate = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : '—';

  function init() {
    $('today-label').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    if (!isConfigured || !clientLib?.createClient) {
      $('login-message').textContent = 'A configuração pública do Supabase está incompleta. Confira o arquivo config.js.';
      $('login-message').classList.add('error');
      $('login-button').disabled = true;
      return;
    }
    db = clientLib.createClient(cfg.SUPABASE_URL, publicKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    bindEvents();
    restoreSession();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
    }
  }

  function bindEvents() {
    $('login-form').addEventListener('submit', signIn);
    $('logout-button').addEventListener('click', signOut);
    document.querySelectorAll('.nav-link').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
    document.querySelectorAll('[data-goto]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.goto)));
    $('add-generator-button').addEventListener('click', () => $('generator-dialog').showModal());
    $('close-generator-dialog').addEventListener('click', closeGeneratorDialog);
    $('cancel-generator').addEventListener('click', closeGeneratorDialog);
    $('generator-form').addEventListener('submit', saveGenerator);
    $('generator-search').addEventListener('input', renderGenerators);
    $('menu-button').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    // Evita executar consultas Supabase dentro do callback de autenticação.
    // O login e a restauração da sessão carregam o perfil explicitamente.
    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') showLogin();
    });
  }

  async function restoreSession() {
    const { data, error } = await db.auth.getSession();
    if (error) { $('login-message').textContent = friendlyError(error); return; }
    if (data.session?.user) await loadProfile(data.session.user);
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $('login-button');
    button.disabled = true;
    button.textContent = 'Entrando...';
    $('login-message').textContent = '';
    try {
      const { data, error } = await db.auth.signInWithPassword({
        email: $('email').value.trim(),
        password: $('password').value
      });
      if (error) throw error;
      await loadProfile(data.user);
    } catch (error) {
      $('login-message').textContent = friendlyError(error);
      $('login-message').classList.add('error');
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar';
    }
  }

  async function loadProfile(user) {
    try {
      const { data, error } = await db.from('perfis').select('id,nome,papel,ativo').eq('id', user.id).single();
      if (error) {
        if (error.code === 'PGRST116') {
          throw new Error('Seu acesso foi autenticado, mas ainda não existe um perfil ativo na DMV. Peça ao administrador para concluir seu cadastro.');
        }
        throw error;
      }
      if (!data?.ativo) throw new Error('Este usuário está inativo. Procure o administrador da DMV.');
      currentUser = user;
      currentProfile = data;
      $('user-name').textContent = data.nome || user.email;
      $('user-role').textContent = roleLabel(data.papel);
      $('user-avatar').textContent = String(data.nome || user.email || 'D').trim().charAt(0).toUpperCase();
      $('connection-label').textContent = 'Banco de dados conectado';
      showApp();
      await refreshDashboard();
      await loadGenerators();
    } catch (error) {
      await db.auth.signOut();
      showLogin();
      $('connection-label').textContent = 'Verifique a conexão';
      $('login-message').textContent = friendlyError(error);
      $('login-message').classList.add('error');
    }
  }

  async function signOut() {
    const { error } = await db.auth.signOut();
    if (error) showToast(friendlyError(error), 'error');
    currentUser = null; currentProfile = null;
    showLogin();
  }

  function showLogin() {
    $('app-shell').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
    $('password').value = '';
  }

  function showApp() {
    $('login-screen').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    $('add-generator-button').classList.toggle('hidden', currentProfile.papel !== 'administrador');
    navigate('inicio');
  }

  function navigate(page) {
    document.querySelectorAll('.page').forEach((section) => section.classList.add('hidden'));
    $(`page-${page}`)?.classList.remove('hidden');
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
    const selected = document.querySelector(`.nav-link[data-page="${page}"]`);
    $('page-title').textContent = selected ? selected.textContent.trim() : 'Visão geral';
    $('sidebar').classList.remove('open');
  }

  async function refreshDashboard() {
    const queries = [
      db.from('geradores').select('id', { count: 'exact', head: true }),
      db.from('ordens_manutencao').select('id', { count: 'exact', head: true }).in('status', ['aberta', 'em_andamento']),
      db.from('pecas').select('id', { count: 'exact', head: true }),
      db.from('baterias').select('id', { count: 'exact', head: true })
    ];
    const results = await Promise.all(queries);
    $('count-generators').textContent = results[0].error ? '—' : results[0].count ?? 0;
    $('count-open-os').textContent = results[1].error ? '—' : results[1].count ?? 0;
    $('count-parts').textContent = results[2].error ? '—' : results[2].count ?? 0;
    $('count-batteries').textContent = results[3].error ? '—' : results[3].count ?? 0;
    const { data, error } = await db.from('ordens_manutencao')
      .select('numero_os,tipo,status,data_abertura,descricao,gerador_id,geradores(numero)')
      .order('data_abertura', { ascending: false }).limit(5);
    const target = $('recent-maintenance');
    if (error) { target.textContent = friendlyError(error); return; }
    if (!data?.length) { target.textContent = 'Nenhuma manutenção registrada ainda.'; target.className = 'empty-state'; return; }
    target.className = 'recent-list';
    target.innerHTML = data.map((item) => `<div class="recent-row"><div><strong>OS #${escapeHtml(item.numero_os)}</strong><span>${escapeHtml(item.geradores?.numero ? `Gerador ${item.geradores.numero}` : 'Gerador')} · ${escapeHtml(item.tipo)}</span></div><span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(item.status.replace('_',' '))}</span><small>${formatDate(item.data_abertura)}</small></div>`).join('');
  }

  async function loadGenerators() {
    const body = $('generators-body');
    body.innerHTML = '<tr><td colspan="6" class="muted">Carregando...</td></tr>';
    const { data, error } = await db.from('geradores')
      .select('id,numero,marca,modelo,potencia_kva,horimetro_atual,localizacao,situacao')
      .order('numero', { ascending: true });
    if (error) {
      body.innerHTML = `<tr><td colspan="6" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`;
      return;
    }
    generatorsCache = data || [];
    renderGenerators();
  }

  function renderGenerators() {
    const query = $('generator-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = generatorsCache.filter((g) => [g.numero,g.marca,g.modelo,g.localizacao].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('generators-body').innerHTML = rows.length ? rows.map((g) => `<tr><td><strong>${escapeHtml(g.numero)}</strong></td><td>${escapeHtml([g.marca,g.modelo].filter(Boolean).join(' / ') || '—')}</td><td>${g.potencia_kva == null ? '—' : `${formatNumber(g.potencia_kva,2)} kVA`}</td><td>${formatNumber(g.horimetro_atual)}</td><td>${escapeHtml(g.localizacao || '—')}</td><td><span class="status-pill ${escapeHtml(g.situacao)}">${escapeHtml(g.situacao.replace('_',' '))}</span></td></tr>`).join('') : '<tr><td colspan="6" class="empty-table">Nenhum gerador encontrado. O cadastro da frota pode ser feito depois.</td></tr>';
  }

  function closeGeneratorDialog() { $('generator-dialog').close(); $('generator-form').reset(); $('generator-error').textContent = ''; }

  async function saveGenerator(event) {
    event.preventDefault();
    if (currentProfile?.papel !== 'administrador') return;
    const save = $('save-generator');
    save.disabled = true; save.textContent = 'Salvando...';
    $('generator-error').textContent = '';
    const record = {
      numero: $('g-number').value.trim(),
      potencia_kva: $('g-power').value ? Number($('g-power').value) : null,
      marca: $('g-brand').value.trim() || null,
      modelo: $('g-model').value.trim() || null,
      ano: $('g-year').value.trim() || null,
      horimetro_atual: $('g-hours').value ? Number($('g-hours').value) : 0,
      numero_serie: $('g-serial').value.trim() || null,
      localizacao: $('g-location').value.trim() || null,
      situacao: $('g-status').value
    };
    try {
      const { error } = await db.from('geradores').insert(record);
      if (error) throw error;
      closeGeneratorDialog();
      await loadGenerators();
      await refreshDashboard();
      showToast('Gerador cadastrado com sucesso.', 'success');
    } catch (error) {
      $('generator-error').textContent = friendlyError(error);
      $('generator-error').classList.add('error');
    } finally {
      save.disabled = false; save.textContent = 'Salvar gerador';
    }
  }

  init();
})();
