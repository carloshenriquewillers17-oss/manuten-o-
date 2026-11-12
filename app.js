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
  let partsCache = [];
  let batteriesCache = [];
  let maintenanceCache = [];
  let editingGeneratorId = null;
  let editingPartId = null;
  let editingBatteryId = null;
  let executionParts = [];
  let activeExecutionOrderId = null;
  let deferredInstallPrompt = null;
  let rentalsCache = []; let rentalEditingId = null; let rentalDeliveryId = null; let rentalGpsCaptured = false;

  const $ = (id) => document.getElementById(id);
  const showToast = (message, kind = 'info') => {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast show ${kind}`;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { el.className = 'toast'; }, 4800);
  };
  const friendlyError = (error) => {
    const msg = error?.message || 'Ocorreu um erro inesperado.';
    if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (/failed to fetch/i.test(msg)) return 'Não foi possível conectar. Confira sua internet e a configuração do Supabase.';
    if (/row-level security|permission denied/i.test(msg)) return 'Seu usuário não tem permissão para esta operação.';
    if (/duplicate key/i.test(msg)) return 'Já existe um cadastro com esse código ou número.';
    if (/violates foreign key/i.test(msg)) return 'Selecione um gerador ou uma peça que já esteja cadastrada.';
    if (/estoque insuficiente/i.test(msg)) return msg;
    if (/bucket not found/i.test(msg)) return 'O bucket fotos-manutencao não foi encontrado. Confira o Storage do Supabase.';
    return msg;
  };
  const normalizedRole = () => String(currentProfile?.papel || '').trim().toLowerCase();
  const roleLabel = (role) => ({ administrador: 'Administrador', tecnico: 'Técnico', almoxarifado: 'Almoxarifado' }[String(role || '').trim().toLowerCase()] || 'Usuário');
  const canOpenMaintenance = () => normalizedRole() === 'administrador';
  const canExecuteMaintenance = () => normalizedRole() === 'tecnico';
  const canManageParts = () => ['administrador', 'almoxarifado'].includes(normalizedRole());
  const canManageBatteries = () => ['administrador', 'tecnico', 'almoxarifado'].includes(normalizedRole());
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatNumber = (value, digits = 1) => value == null ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
  const formatMoney = (value) => value == null ? '—' : Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const formatDate = (value) => {
    if (!value) return '—';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR');
  };
  const toNullableNumber = (value) => value === '' || value == null ? null : Number(value);
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

  function setupPwaInstall() {
    const installButton = $('install-app-button');
    if (!installButton) return;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) {
      installButton.classList.add('hidden');
      return;
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.textContent = 'Instalar aplicativo';
    });
    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) {
        const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
        showToast(isAppleMobile
          ? 'No iPhone: toque em Compartilhar no Safari e escolha Adicionar à Tela de Início.'
          : 'No Android: abra no Chrome, toque nos três pontos e escolha Instalar aplicativo ou Adicionar à tela inicial.');
        return;
      }
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice?.outcome === 'accepted') showToast('Instalação solicitada. Procure o ícone DMV na tela do celular.', 'success');
      } catch (error) {
        showToast('Para instalar, use o menu do navegador e escolha Instalar aplicativo.');
      }
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      installButton.classList.add('hidden');
      showToast('Aplicativo DMV instalado com sucesso!', 'success');
    });
  }

  function init() {
    setupPwaInstall();
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
    document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.closeDialog)));

    $('add-generator-button').addEventListener('click', () => $('generator-dialog').showModal());
    $('close-generator-dialog').addEventListener('click', closeGeneratorDialog);
    $('cancel-generator').addEventListener('click', closeGeneratorDialog);
    $('generator-form').addEventListener('submit', saveGenerator);
    $('generator-search').addEventListener('input', renderGenerators);
    $('generators-body').addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-generator]');
      if (button) openEditGenerator(button.dataset.editGenerator);
    });

    $('add-maintenance-button').addEventListener('click', openMaintenanceDialog);
    $('maintenance-form').addEventListener('submit', saveMaintenance);
    $('maintenance-search').addEventListener('input', renderMaintenance);
    $('maintenance-body').addEventListener('click', handleMaintenanceAction);
    $('maintenance-body').addEventListener('keydown', handleMaintenanceRowKeydown);
    $('e-add-part').addEventListener('click', addExecutionPart);
    $('execution-form').addEventListener('submit', saveExecution);

    $('add-part-button').addEventListener('click', openNewPartDialog);
    $('part-form').addEventListener('submit', savePart);
    $('part-search').addEventListener('input', renderParts);
    $('parts-body').addEventListener('click', handlePartAction);
    $('add-movement-button').addEventListener('click', openMovementDialog);
    $('movement-form').addEventListener('submit', saveMovement);

    $('add-battery-button').addEventListener('click', openNewBatteryDialog);
    $('battery-form').addEventListener('submit', saveBattery);
    $('battery-search').addEventListener('input', renderBatteries);
    $('batteries-body').addEventListener('click', handleBatteryAction);

    bindRentalEvents();
    $('menu-button').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    db.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showLogin(); });
  }

  async function restoreSession() {
    const { data, error } = await db.auth.getSession();
    if (error) { $('login-message').textContent = friendlyError(error); return; }
    if (data.session?.user) await loadProfile(data.session.user);
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $('login-button');
    button.disabled = true; button.textContent = 'Entrando...'; $('login-message').textContent = '';
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
      if (error) throw error;
      await loadProfile(data.user);
    } catch (error) {
      $('login-message').textContent = friendlyError(error); $('login-message').classList.add('error');
    } finally { button.disabled = false; button.textContent = 'Entrar'; }
  }

  async function loadProfile(user) {
    try {
      const { data, error } = await db.from('perfis').select('id,nome,papel,ativo').eq('id', user.id).single();
      if (error) {
        if (error.code === 'PGRST116') throw new Error('Seu acesso foi autenticado, mas ainda não existe um perfil ativo na DMV. Peça ao administrador para concluir seu cadastro.');
        throw error;
      }
      if (!data?.ativo) throw new Error('Este usuário está inativo. Procure o administrador da DMV.');
      currentUser = user; currentProfile = data;
      $('user-name').textContent = data.nome || user.email;
      $('user-role').textContent = roleLabel(data.papel);
      $('user-avatar').textContent = String(data.nome || user.email || 'D').trim().charAt(0).toUpperCase();
      $('connection-label').textContent = 'Banco de dados conectado';
      showApp();
      await Promise.all([refreshDashboard(), loadGenerators(), loadParts(), loadBatteries(), loadMaintenance()]);
      applyRoleVisibility();
    } catch (error) {
      await db.auth.signOut(); showLogin(); $('connection-label').textContent = 'Verifique a conexão';
      $('login-message').textContent = friendlyError(error); $('login-message').classList.add('error');
    }
  }

  async function signOut() {
    const { error } = await db.auth.signOut();
    if (error) showToast(friendlyError(error), 'error');
    currentUser = null; currentProfile = null; showLogin();
  }

  function showLogin() { $('app-shell').classList.add('hidden'); $('login-screen').classList.remove('hidden'); $('password').value = ''; }
  function showApp() { $('login-screen').classList.add('hidden'); $('app-shell').classList.remove('hidden'); navigate('inicio'); }
  function applyRoleVisibility() {
    $('add-generator-button').classList.toggle('hidden', !canOpenMaintenance());
    $('add-part-button').classList.toggle('hidden', !canManageParts());
    $('add-movement-button').classList.toggle('hidden', !canManageParts());
    $('add-battery-button').classList.toggle('hidden', !canManageBatteries());
    $('add-maintenance-button').classList.toggle('hidden', !canOpenMaintenance());
    $('maintenance-role-note').classList.toggle('hidden', !canExecuteMaintenance());
    $('r-new').classList.toggle('hidden', normalizedRole() !== 'administrador');
  }

  async function navigate(page) {
    document.querySelectorAll('.page').forEach((section) => section.classList.add('hidden'));
    $(`page-${page}`)?.classList.remove('hidden');
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
    const selected = document.querySelector(`.nav-link[data-page="${page}"]`);
    $('page-title').textContent = selected ? selected.textContent.trim() : 'Visão geral';
    $('sidebar').classList.remove('open');
    try {
      if (page === 'geradores') await loadGenerators();
      if (page === 'manutencoes') await loadMaintenance();
      if (page === 'estoque') await loadParts();
      if (page === 'baterias') await loadBatteries();
      if (page === 'alugueis') await loadRentals();
    } catch (error) { showToast(friendlyError(error), 'error'); }
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
    const { data, error } = await db.from('ordens_manutencao').select('numero_os,tipo,status,data_abertura,geradores(numero)').order('data_abertura', { ascending: false }).limit(5);
    const target = $('recent-maintenance');
    if (error) { target.textContent = friendlyError(error); return; }
    if (!data?.length) { target.textContent = 'Nenhuma manutenção registrada ainda.'; target.className = 'empty-state'; return; }
    target.className = 'recent-list';
    target.innerHTML = data.map((item) => `<div class="recent-row"><div><strong>OS #${escapeHtml(item.numero_os)}</strong><span>${escapeHtml(item.geradores?.numero ? `Gerador ${item.geradores.numero}` : 'Gerador')} · ${escapeHtml(item.tipo)}</span></div><span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(item.status.replace('_',' '))}</span><small>${formatDate(item.data_abertura)}</small></div>`).join('');
  }

  async function loadGenerators() {
    const body = $('generators-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="muted">Carregando...</td></tr>';
    const { data, error } = await db.from('geradores').select('id,numero,marca,modelo,potencia_kva,horimetro_atual,localizacao,situacao,ano,numero_serie,ultima_preventiva_em,ultima_preventiva_horimetro').order('numero', { ascending: true });
    if (error) { body.innerHTML = `<tr><td colspan="7" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    generatorsCache = data || []; renderGenerators(); renderPreventiveAlerts(); populateGeneratorSelects();
  }

  function populateGeneratorSelects() {
    const options = generatorsCache.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(`Gerador ${g.numero}${g.marca ? ` · ${g.marca}` : ''}${g.potencia_kva ? ` · ${formatNumber(g.potencia_kva,0)} kVA` : ''}`)}</option>`).join('');
    ['m-generator'].forEach((id) => { const el = $(id); if (el) el.innerHTML = `<option value="">Selecione o gerador</option>${options}`; });
    const battery = $('b-generator'); if (battery) battery.innerHTML = `<option value="">Nenhum (em estoque)</option>${options}`;
  }

  function renderGenerators() {
    const query = $('generator-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = generatorsCache.filter((g) => [g.numero,g.marca,g.modelo,g.localizacao].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('generators-body').innerHTML = rows.length ? rows.map((g) => {
      const preventive = getPreventiveState(g);
      return `<tr><td><strong>${escapeHtml(g.numero)}</strong></td><td>${escapeHtml([g.marca,g.modelo].filter(Boolean).join(' / ') || '—')}</td><td>${g.potencia_kva == null ? '—' : `${formatNumber(g.potencia_kva,2)} kVA`}</td><td>${formatNumber(g.horimetro_atual)}<small class="table-subline ${preventive.level === 'overdue' ? 'text-danger' : preventive.level === 'soon' || preventive.level === 'unknown' ? 'text-warning' : ''}">${escapeHtml(preventive.label)}</small></td><td>${escapeHtml(g.localizacao || '—')}</td><td><span class="status-pill ${escapeHtml(g.situacao)}">${escapeHtml(g.situacao.replace('_',' '))}</span></td><td>${currentProfile?.papel === 'administrador' ? `<button type="button" class="btn btn-outline table-action" data-edit-generator="${escapeHtml(g.id)}">Editar</button>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-table">Nenhum gerador encontrado. Use “Novo gerador” para cadastrar a frota.</td></tr>';
  }

  function addMonthsLocal(dateValue, months) {
    if (!dateValue) return null;
    const parts = String(dateValue).slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const [year, month, day] = parts;
    const first = new Date(year, month - 1 + months, 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    first.setDate(Math.min(day, lastDay));
    return first;
  }

  function getPreventiveState(generator) {
    const lastDate = generator.ultima_preventiva_em;
    const lastHours = generator.ultima_preventiva_horimetro;
    if (!lastDate && lastHours == null) return { level: 'unknown', label: 'Sem preventiva registrada', detail: 'Cadastre a última preventiva para iniciar o controle automático.' };
    const now = new Date(); now.setHours(0,0,0,0);
    const dueDate = addMonthsLocal(lastDate, 6);
    const daysLeft = dueDate ? Math.ceil((dueDate.getTime() - now.getTime()) / 86400000) : null;
    const hoursDue = lastHours == null ? null : Number(lastHours) + 250;
    const hoursLeft = hoursDue == null ? null : hoursDue - Number(generator.horimetro_atual || 0);
    const byHours = hoursLeft != null && hoursLeft <= 0;
    const byDate = daysLeft != null && daysLeft <= 0;
    if (byHours || byDate) {
      const why = [byHours ? 'limite de 250 horas atingido' : '', byDate ? 'limite de 6 meses atingido' : ''].filter(Boolean).join(' e ');
      return { level: 'overdue', label: 'Preventiva vencida', detail: why };
    }
    if (daysLeft != null && daysLeft <= 15) return { level: 'soon', label: `Vence em ${daysLeft} dia(s)`, detail: `Data limite: ${dueDate.toLocaleDateString('pt-BR')}${hoursLeft != null ? ` · faltam ${formatNumber(Math.max(0,hoursLeft))} h para 250 horas` : ''}` };
    const parts = [];
    if (hoursLeft != null) parts.push(`faltam ${formatNumber(hoursLeft)} h`);
    if (daysLeft != null) parts.push(`faltam ${daysLeft} dias`);
    return { level: 'ok', label: 'Preventiva em dia', detail: parts.join(' · ') || 'Acompanhar horímetro e data da próxima preventiva.' };
  }

  function renderPreventiveAlerts() {
    const target = $('preventive-alerts'); if (!target) return;
    if (!generatorsCache.length) { target.innerHTML = '<div class="empty-state">Cadastre os geradores para acompanhar as preventivas.</div>'; return; }
    const due = generatorsCache.map((g) => ({ generator: g, state: getPreventiveState(g) })).filter((x) => x.state.level !== 'ok');
    if (!due.length) { target.innerHTML = '<div class="preventive-good">Todas as preventivas estão dentro do prazo conforme os dados registrados.</div>'; return; }
    target.innerHTML = due.map(({generator,state}) => `<div class="preventive-row ${state.level}"><div><strong>Gerador ${escapeHtml(generator.numero)}</strong><span>${escapeHtml(state.detail)}</span></div><b>${escapeHtml(state.label)}</b></div>`).join('');
  }

  function openEditGenerator(id) {
    if (currentProfile?.papel !== 'administrador') return;
    const g = generatorsCache.find((item) => item.id === id); if (!g) return;
    editingGeneratorId = id; $('generator-dialog-title').textContent = 'Editar gerador'; $('save-generator').textContent = 'Salvar alterações';
    $('g-number').value = g.numero ?? ''; $('g-power').value = g.potencia_kva ?? ''; $('g-brand').value = g.marca ?? ''; $('g-model').value = g.modelo ?? '';
    $('g-year').value = g.ano ?? ''; $('g-hours').value = g.horimetro_atual ?? 0; $('g-serial').value = g.numero_serie ?? ''; $('g-location').value = g.localizacao ?? ''; $('g-status').value = g.situacao ?? 'disponivel';
    $('generator-error').textContent = ''; $('generator-dialog').showModal();
  }
  function closeGeneratorDialog() { closeDialog('generator-dialog'); $('generator-form').reset(); $('generator-error').textContent = ''; editingGeneratorId = null; $('generator-dialog-title').textContent = 'Novo gerador'; $('save-generator').textContent = 'Salvar gerador'; }
  async function saveGenerator(event) {
    event.preventDefault(); if (currentProfile?.papel !== 'administrador') return;
    const save = $('save-generator'); save.disabled = true; save.textContent = 'Salvando...'; $('generator-error').textContent = '';
    const record = { numero: $('g-number').value.trim(), potencia_kva: toNullableNumber($('g-power').value), marca: $('g-brand').value.trim() || null, modelo: $('g-model').value.trim() || null, ano: $('g-year').value.trim() || null, horimetro_atual: Number($('g-hours').value || 0), numero_serie: $('g-serial').value.trim() || null, localizacao: $('g-location').value.trim() || null, situacao: $('g-status').value };
    try {
      const result = editingGeneratorId ? await db.from('geradores').update(record).eq('id', editingGeneratorId) : await db.from('geradores').insert(record);
      if (result.error) throw result.error;
      const wasEditing = Boolean(editingGeneratorId); closeGeneratorDialog(); await loadGenerators(); await refreshDashboard(); showToast(wasEditing ? 'Gerador atualizado.' : 'Gerador cadastrado.', 'success');
    } catch (error) { $('generator-error').textContent = friendlyError(error); $('generator-error').classList.add('error'); }
    finally { save.disabled = false; save.textContent = 'Salvar gerador'; }
  }

  async function loadMaintenance() {
    const body = $('maintenance-body'); if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="muted">Carregando...</td></tr>';
    const { data, error } = await db.from('ordens_manutencao')
      .select('id,numero_os,gerador_id,tipo,status,data_abertura,data_conclusao,horimetro,horimetro_final,descricao,servico_solicitado,defeito_provavel,servicos_realizados,observacoes,tecnico_id,created_by,geradores(numero)')
      .order('data_abertura', { ascending: false });
    if (error) { body.innerHTML = `<tr><td colspan="7" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    maintenanceCache = data || []; renderMaintenance();
  }

  function renderMaintenance() {
    const query = $('maintenance-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = maintenanceCache.filter((m) => [m.numero_os,m.geradores?.numero,m.descricao,m.servico_solicitado,m.defeito_provavel,m.tipo,m.status].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('maintenance-body').innerHTML = rows.length ? rows.map((m) => {
      const canThisTechnicianExecute = canExecuteMaintenance() && ['aberta','em_andamento'].includes(m.status) && (!m.tecnico_id || m.tecnico_id === currentUser.id);
      const detailLabel = canExecuteMaintenance() ? 'Ver solicitação' : 'Ver OS';
      const actions = [`<button type="button" class="btn btn-outline table-action" data-os-details="${m.id}">${detailLabel}</button>`];
      if (!canExecuteMaintenance()) actions.push(`<button type="button" class="btn btn-outline table-action" data-os-photos="${m.id}">Fotos</button>`);
      if (canThisTechnicianExecute) actions.push(`<button type="button" class="btn btn-primary table-action" data-os-execute="${m.id}">${m.status === 'aberta' ? 'Iniciar OS' : 'Finalizar OS'}</button>`);
      if (canOpenMaintenance()) actions.push(`<button type="button" class="btn btn-danger table-action admin-delete-button" data-os-delete="${m.id}" aria-label="Excluir OS ${escapeHtml(m.numero_os)}">Excluir OS</button>`);
      const hours = `${formatNumber(m.horimetro)}${m.horimetro_final == null ? '' : ` / ${formatNumber(m.horimetro_final)}`}`;
      return `<tr class="maintenance-click-row" data-os-row="${m.id}" tabindex="0" role="button" aria-label="Abrir detalhes da OS ${escapeHtml(m.numero_os)}"><td><strong>#${escapeHtml(m.numero_os)}</strong></td><td>${escapeHtml(m.geradores?.numero ? `Gerador ${m.geradores.numero}` : '—')}</td><td>${escapeHtml(m.tipo)}</td><td>${formatDate(m.data_abertura)}</td><td>${hours}</td><td><span class="status-pill ${escapeHtml(m.status)}">${escapeHtml(m.status.replace('_',' '))}</span></td><td><div class="table-actions">${actions.join('')}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-table">Nenhuma ordem de serviço cadastrada.</td></tr>';
  }

  function openMaintenanceDialog() {
    if (!canOpenMaintenance()) return showToast('Somente o administrador pode abrir uma ordem de serviço.', 'error');
    if (!generatorsCache.length) return showToast('Cadastre um gerador antes de abrir uma ordem de serviço.', 'error');
    $('maintenance-form').reset(); $('m-date').value = todayISO(); $('maintenance-error').textContent = '';
    populateGeneratorSelects(); $('maintenance-dialog').showModal();
  }

  async function saveMaintenance(event) {
    event.preventDefault(); if (!canOpenMaintenance()) return;
    const save = $('save-maintenance'); save.disabled = true; save.textContent = 'Abrindo OS...'; $('maintenance-error').textContent = '';
    try {
      const generatorId = $('m-generator').value;
      if (!generatorId) throw new Error('Selecione o gerador da ordem de serviço.');
      const openingHours = Number($('m-hours').value);
      if (!Number.isFinite(openingHours) || openingHours < 0) throw new Error('Informe um horímetro inicial válido.');
      const requested = $('m-requested').value.trim();
      if (!requested) throw new Error('Descreva o que precisa ser feito.');
      const suspected = $('m-suspected').value.trim() || null;
      const selectedDate = $('m-date').value;
      const record = {
        gerador_id: generatorId,
        tipo: $('m-type').value,
        status: 'aberta',
        horimetro: openingHours,
        descricao: requested,
        servico_solicitado: requested,
        defeito_provavel: suspected,
        servicos_realizados: null,
        observacoes: null,
        tecnico_id: null,
        created_by: currentUser.id
      };
      if (selectedDate) record.data_abertura = new Date(`${selectedDate}T12:00:00`).toISOString();
      const { data, error } = await db.from('ordens_manutencao').insert(record).select('id,numero_os').single();
      if (error) throw error;
      closeDialog('maintenance-dialog'); $('maintenance-form').reset();
      await Promise.all([loadMaintenance(), loadGenerators(), refreshDashboard()]);
      showToast(`OS #${data.numero_os} aberta e disponível para os técnicos.`, 'success');
    } catch (error) {
      $('maintenance-error').textContent = friendlyError(error); $('maintenance-error').classList.add('error');
    } finally { save.disabled = false; save.textContent = 'Abrir ordem de serviço'; }
  }

  function populateMaintenancePartSelect() {
    const select = $('e-part-select'); if (!select) return;
    select.innerHTML = `<option value="">Selecione uma peça</option>${partsCache.map((p) => `<option value="${p.id}">${escapeHtml(`${p.nome} · estoque ${formatNumber(p.quantidade_estoque,2)} ${p.unidade || 'un'}`)}</option>`).join('')}`;
  }

  function addExecutionPart() {
    const id = $('e-part-select').value; const qty = Number($('e-part-quantity').value);
    const part = partsCache.find((item) => item.id === id);
    if (!part) return showToast('Selecione uma peça cadastrada.', 'error');
    if (!Number.isFinite(qty) || qty <= 0) return showToast('Informe uma quantidade válida.', 'error');
    const existing = executionParts.find((item) => item.peca_id === id);
    if (existing) existing.quantidade += qty;
    else executionParts.push({ peca_id: id, nome: part.nome, unidade: part.unidade || 'un', quantidade: qty, custo_unitario: part.custo_unitario });
    renderExecutionParts();
  }

  function renderExecutionParts() {
    const box = $('e-selected-parts');
    if (!executionParts.length) { box.className = 'selected-list empty-state'; box.textContent = 'Nenhuma peça adicionada.'; return; }
    box.className = 'selected-list';
    box.innerHTML = executionParts.map((item, index) => `<div class="selected-item"><span>${escapeHtml(item.nome)} · ${formatNumber(item.quantidade,2)} ${escapeHtml(item.unidade)}</span><button type="button" class="btn btn-outline table-action" data-remove-execution-part="${index}">Remover</button></div>`).join('');
    box.querySelectorAll('[data-remove-execution-part]').forEach((button) => button.addEventListener('click', () => { executionParts.splice(Number(button.dataset.removeExecutionPart), 1); renderExecutionParts(); }));
  }

  async function openExecutionDialog(orderId) {
    if (!canExecuteMaintenance()) return showToast('Somente o técnico pode registrar a execução da ordem.', 'error');
    let order = maintenanceCache.find((item) => item.id === orderId);
    if (!order) return showToast('Ordem de serviço não encontrada. Atualize a lista.', 'error');
    if (!['aberta','em_andamento'].includes(order.status)) return showToast('Esta ordem não está mais disponível para execução.', 'error');
    if (order.tecnico_id && order.tecnico_id !== currentUser.id) return showToast('Esta OS já está em atendimento por outro técnico.', 'error');

    if (order.status === 'aberta') {
      const { data, error } = await db.from('ordens_manutencao')
        .update({ status: 'em_andamento', tecnico_id: currentUser.id })
        .eq('id', orderId).eq('status', 'aberta')
        .select('id');
      if (error) return showToast(friendlyError(error), 'error');
      if (!data?.length) { await loadMaintenance(); return showToast('Outro usuário já iniciou esta OS. Atualize a lista.', 'error'); }
      await loadMaintenance();
      order = maintenanceCache.find((item) => item.id === orderId) || order;
    }

    activeExecutionOrderId = orderId; executionParts = [];
    $('execution-form').reset(); $('execution-error').textContent = '';
    $('execution-dialog-title').textContent = `Atender OS #${order.numero_os}`;
    $('execution-order-summary').textContent = `Gerador ${order.geradores?.numero || '—'} · ${order.tipo} · Horímetro inicial: ${formatNumber(order.horimetro)} h`;
    $('execution-request').textContent = order.servico_solicitado || order.descricao || 'Solicitação não informada.';
    $('execution-suspected').textContent = order.defeito_provavel || 'Nenhum provável defeito informado.';
    $('e-final-hours').value = order.horimetro_final ?? '';
    $('e-final-hours').min = String(Number(order.horimetro || 0));
    $('e-final-hours').placeholder = `Mínimo ${formatNumber(order.horimetro || 0)} h`;
    $('e-finished-date').value = todayISO();
    $('e-services').value = order.servicos_realizados || '';
    $('e-notes').value = order.observacoes || '';
    $('e-part-quantity').value = '1';
    populateMaintenancePartSelect(); renderExecutionParts();
    $('execution-dialog').showModal();
  }

  async function saveExecution(event) {
    event.preventDefault(); if (!canExecuteMaintenance() || !activeExecutionOrderId) return;
    const save = $('save-execution'); save.disabled = true; save.textContent = 'Salvando execução...'; $('execution-error').textContent = '';
    try {
      const order = maintenanceCache.find((item) => item.id === activeExecutionOrderId);
      if (!order) throw new Error('Ordem de serviço não encontrada. Atualize a lista.');
      const finalHours = Number($('e-final-hours').value);
      if ($('e-final-hours').value.trim() === '' || !Number.isFinite(finalHours) || finalHours < 0) { $('e-final-hours').focus(); throw new Error('Informe o HORÍMETRO FINAL antes de concluir a manutenção.'); }
      if (order.horimetro != null && finalHours < Number(order.horimetro)) { $('e-final-hours').focus(); throw new Error(`O horímetro final (${formatNumber(finalHours)} h) não pode ser menor que o inicial (${formatNumber(order.horimetro)} h).`); }
      const services = $('e-services').value.trim();
      if (!services) throw new Error('Descreva o que foi feito na manutenção.');

      const { data: existingItems, error: existingError } = await db.from('itens_manutencao').select('peca_id').eq('ordem_id', activeExecutionOrderId);
      if (existingError) throw existingError;
      const alreadyAdded = new Set((existingItems || []).map((item) => item.peca_id));
      for (const item of executionParts) {
        if (alreadyAdded.has(item.peca_id)) continue;
        const part = partsCache.find((entry) => entry.id === item.peca_id);
        if (part && Number(part.quantidade_estoque) < item.quantidade) throw new Error(`Estoque insuficiente para ${part.nome}. Disponível: ${formatNumber(part.quantidade_estoque,2)}.`);
      }
      for (const item of executionParts) {
        if (alreadyAdded.has(item.peca_id)) continue;
        const { error } = await db.from('itens_manutencao').insert({ ordem_id: activeExecutionOrderId, peca_id: item.peca_id, quantidade: item.quantidade, custo_unitario: item.custo_unitario });
        if (error) throw error;
        alreadyAdded.add(item.peca_id);
      }

      const photoSummary = await uploadMaintenancePhotos(activeExecutionOrderId);
      const patch = {
        status: 'concluida',
        tecnico_id: currentUser.id,
        servicos_realizados: services,
        observacoes: $('e-notes').value.trim() || null,
        horimetro_final: finalHours,
        data_conclusao: new Date().toISOString()
      };
      const { data: completedOrder, error: updateError } = await db.from('ordens_manutencao')
        .update(patch).eq('id', activeExecutionOrderId)
        .select('id,horimetro_final,status').single();
      if (updateError) throw updateError;
      if (!completedOrder || completedOrder.status !== 'concluida' || Number(completedOrder.horimetro_final) !== finalHours) {
        throw new Error('A OS não confirmou o salvamento do horímetro final. Confira sua conexão e tente novamente.');
      }

      const orderNo = order.numero_os;
      closeDialog('execution-dialog'); $('execution-form').reset(); executionParts = []; activeExecutionOrderId = null;
      await Promise.all([loadMaintenance(), loadParts(), loadGenerators(), refreshDashboard()]);
      showToast(`OS #${orderNo} concluída. Horímetro atualizado para ${formatNumber(finalHours)} h.${photoSummary ? ` ${photoSummary}` : ''}`, 'success');
    } catch (error) {
      $('execution-error').textContent = friendlyError(error); $('execution-error').classList.add('error');
    } finally { save.disabled = false; save.textContent = 'Finalizar ordem de serviço'; }
  }

  async function uploadMaintenancePhotos(orderId) {
    const groups = [
      { id: 'e-photos-before', stage: 'antes' },
      { id: 'e-photos-during', stage: 'durante' },
      { id: 'e-photos-after', stage: 'depois' }
    ];
    let uploaded = 0;
    for (const group of groups) {
      const files = Array.from($(group.id).files || []);
      for (const file of files) {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error(`Arquivo ${file.name}: use JPG, PNG ou WEBP.`);
        if (file.size > 10 * 1024 * 1024) throw new Error(`Arquivo ${file.name}: ultrapassa o limite de 10 MB.`);
        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
        const path = `${orderId}/${group.stage}/${safeName}`;
        const { error: uploadError } = await db.storage.from('fotos-manutencao').upload(path, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
        const { error: rowError } = await db.from('fotos_manutencao').insert({ ordem_id: orderId, caminho_storage: path, etapa: group.stage, legenda: file.name, enviado_por: currentUser.id });
        if (rowError) throw rowError;
        uploaded += 1;
      }
    }
    return uploaded ? `${uploaded} foto(s) anexada(s).` : '';
  }

  async function handleMaintenanceAction(event) {
    const clicked = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!clicked) return;
    const remove = clicked.closest('[data-os-delete]');
    const details = clicked.closest('[data-os-details]');
    const photos = clicked.closest('[data-os-photos]');
    const execute = clicked.closest('[data-os-execute]');
    if (remove) { event.preventDefault(); event.stopPropagation(); await deleteMaintenanceOrder(remove.dataset.osDelete); return; }
    if (details) { event.preventDefault(); await showMaintenanceDetails(details.dataset.osDetails); return; }
    if (photos) { event.preventDefault(); await showMaintenancePhotos(photos.dataset.osPhotos); return; }
    if (execute) { event.preventDefault(); await openExecutionDialog(execute.dataset.osExecute); return; }
    const row = clicked.closest('[data-os-row]');
    if (row) await showMaintenanceDetails(row.dataset.osRow);
  }

  async function deleteMaintenanceOrder(orderId) {
    if (!canOpenMaintenance()) return showToast('Somente o administrador pode excluir ordens de serviço.', 'error');
    const order = maintenanceCache.find((item) => item.id === orderId);
    if (!order) return showToast('Ordem de serviço não encontrada. Atualize a lista.', 'error');
    const osLabel = `OS #${order.numero_os}`;
    const confirmed = window.confirm(
      `Deseja EXCLUIR DEFINITIVAMENTE a ${osLabel}?\n\n` +
      'Os dados e fotos desta ordem serão removidos. As peças consumidas nesta OS voltarão ao estoque.\n\n' +
      'Esta ação não pode ser desfeita.'
    );
    if (!confirmed) return;

    showToast(`Excluindo ${osLabel}...`);
    try {
      // A função no banco valida novamente o perfil administrador e faz a
      // exclusão transacional, devolvendo ao estoque as peças desta OS.
      const { data, error } = await db.rpc('dmv_excluir_ordem_servico', { p_ordem_id: orderId });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      const photoPaths = Array.isArray(result?.foto_paths) ? result.foto_paths.filter(Boolean) : [];
      let photoCleanupFailed = false;
      if (photoPaths.length) {
        const { error: storageError } = await db.storage.from('fotos-manutencao').remove(photoPaths);
        if (storageError) {
          photoCleanupFailed = true;
          console.warn('A OS foi excluída, mas houve falha ao remover alguns arquivos do Storage:', storageError);
        }
      }
      closeDialog('maintenance-detail-dialog');
      await Promise.all([loadMaintenance(), loadParts(), refreshDashboard()]);
      if (photoCleanupFailed) {
        showToast(`${osLabel} excluída. Atenção: não foi possível remover todos os arquivos de foto do armazenamento.`, 'error');
      } else {
        showToast(`${osLabel} excluída. As peças consumidas foram devolvidas ao estoque.`, 'success');
      }
    } catch (error) {
      showToast(friendlyError(error), 'error');
    }
  }

  async function handleMaintenanceRowKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target instanceof Element ? event.target.closest('[data-os-row]') : null;
    if (!row) return;
    event.preventDefault();
    await showMaintenanceDetails(row.dataset.osRow);
  }

  async function showMaintenanceDetails(orderId) {
    const target = $('maintenance-detail-content');
    const cached = maintenanceCache.find((m) => m.id === orderId);
    target.innerHTML = '<p class="muted">Carregando dados da ordem...</p>';
    $('maintenance-detail-title').textContent = `Ordem de serviço #${cached?.numero_os || ''}`;
    $('maintenance-detail-dialog').showModal();

    try {
      // Busca primeiro somente a OS e o gerador. Assim a tela não depende de
      // uma consulta aninhada de peças para conseguir abrir a solicitação.
      const { data, error } = await db.from('ordens_manutencao')
        .select('id,numero_os,gerador_id,tipo,status,data_abertura,data_conclusao,horimetro,horimetro_final,descricao,servico_solicitado,defeito_provavel,servicos_realizados,observacoes,tecnico_id,geradores(numero,marca,modelo,potencia_kva)')
        .eq('id', orderId).single();
      if (error) throw error;

      let parts = [];
      const { data: itemRows, error: itemError } = await db.from('itens_manutencao')
        .select('peca_id,quantidade,custo_unitario').eq('ordem_id', orderId);
      if (!itemError && itemRows?.length) {
        const ids = [...new Set(itemRows.map((item) => item.peca_id).filter(Boolean))];
        const { data: partRows } = await db.from('pecas').select('id,nome,codigo,unidade').in('id', ids);
        const byId = new Map((partRows || []).map((part) => [part.id, part]));
        parts = itemRows.map((item) => ({ ...item, pecas: byId.get(item.peca_id) || null }));
      }

      const canExecuteThisOrder = canExecuteMaintenance() && ['aberta','em_andamento'].includes(data.status) && (!data.tecnico_id || data.tecnico_id === currentUser.id);
      const executeButton = canExecuteThisOrder
        ? `<button type="button" class="btn btn-primary" data-detail-execute="${data.id}">${data.status === 'aberta' ? 'Iniciar OS' : 'Finalizar OS'}</button>`
        : '';
      const deleteButton = canOpenMaintenance()
        ? `<div class="admin-delete-panel"><div><strong>Ação do administrador</strong><span>Exclusão definitiva desta ordem de serviço.</span></div><button type="button" class="btn btn-danger admin-delete-button" data-detail-delete="${data.id}">Excluir esta OS</button></div>`
        : '';
      target.innerHTML = `${deleteButton}<div class="detail-grid">
        <div><small>Gerador</small><strong>${escapeHtml(data.geradores?.numero ? `Nº ${data.geradores.numero}` : '—')}</strong><span>${escapeHtml([data.geradores?.marca,data.geradores?.modelo].filter(Boolean).join(' / '))}</span></div>
        <div><small>Tipo / status</small><strong>${escapeHtml(data.tipo)} · ${escapeHtml(data.status.replaceAll('_',' '))}</strong></div>
        <div><small>Data de abertura</small><strong>${formatDate(data.data_abertura)}</strong></div>
        <div><small>Data de conclusão</small><strong>${formatDate(data.data_conclusao)}</strong></div>
        <div><small>Horímetro inicial</small><strong>${formatNumber(data.horimetro)} h</strong></div>
        <div><small>Horímetro final</small><strong>${data.horimetro_final == null ? 'Aguardando técnico' : `${formatNumber(data.horimetro_final)} h`}</strong></div>
        <div class="detail-wide"><small>O que o administrador solicitou</small><p>${escapeHtml(data.servico_solicitado || data.descricao || '—')}</p></div>
        <div class="detail-wide"><small>Provável defeito / observação inicial</small><p>${escapeHtml(data.defeito_provavel || 'Não informado')}</p></div>
        <div class="detail-wide"><small>O que o técnico realizou</small><p>${escapeHtml(data.servicos_realizados || 'Aguardando execução do técnico')}</p></div>
        <div class="detail-wide"><small>Observações do técnico</small><p>${escapeHtml(data.observacoes || '—')}</p></div>
        <div class="detail-wide"><small>Peças utilizadas</small>${parts.length ? `<ul>${parts.map((item) => `<li>${escapeHtml(item.pecas?.nome || 'Peça')} — ${formatNumber(item.quantidade,2)} ${escapeHtml(item.pecas?.unidade || 'un')}${item.pecas?.codigo ? ` · cód. ${escapeHtml(item.pecas.codigo)}` : ''}</li>`).join('')}</ul>` : '<p>Nenhuma peça lançada nesta OS.</p>'}</div>
      </div><div class="detail-actions"><button type="button" class="btn btn-outline" data-detail-photos="${data.id}">Ver fotos desta OS</button>${executeButton}</div>`;
      target.querySelector('[data-detail-photos]')?.addEventListener('click', () => { closeDialog('maintenance-detail-dialog'); showMaintenancePhotos(orderId); });
      target.querySelector('[data-detail-execute]')?.addEventListener('click', () => { closeDialog('maintenance-detail-dialog'); openExecutionDialog(orderId); });
      target.querySelector('[data-detail-delete]')?.addEventListener('click', async () => { closeDialog('maintenance-detail-dialog'); await deleteMaintenanceOrder(orderId); });
    } catch (error) {
      target.innerHTML = `<div class="empty-state error-cell">Não foi possível carregar os detalhes desta OS: ${escapeHtml(friendlyError(error))}</div>`;
    }
  }

  async function showMaintenancePhotos(orderId) {
    $('photos-gallery').innerHTML = '<p class="muted">Carregando fotos...</p>';
    $('photos-title').textContent = `Fotos da OS #${maintenanceCache.find((m) => m.id === orderId)?.numero_os || ''}`;
    $('photos-dialog').showModal();
    const { data, error } = await db.from('fotos_manutencao').select('id,caminho_storage,etapa,legenda,created_at').eq('ordem_id', orderId).order('created_at', { ascending: true });
    if (error) { $('photos-gallery').textContent = friendlyError(error); return; }
    if (!data?.length) { $('photos-gallery').innerHTML = '<div class="empty-state">Nenhuma foto anexada a esta manutenção.</div>'; return; }
    const signed = await Promise.all(data.map(async (photo) => {
      const { data: urlData, error: urlError } = await db.storage.from('fotos-manutencao').createSignedUrl(photo.caminho_storage, 3600);
      return { ...photo, signedUrl: urlError ? null : urlData?.signedUrl };
    }));
    $('photos-gallery').innerHTML = signed.map((photo) => `<figure class="photo-card">${photo.signedUrl ? `<a href="${escapeHtml(photo.signedUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(photo.signedUrl)}" alt="Foto ${escapeHtml(photo.etapa)}" loading="lazy"></a>` : '<div class="photo-unavailable">Foto indisponível</div>'}<figcaption><strong>${escapeHtml(photo.etapa)}</strong><span>${escapeHtml(photo.legenda || '')}</span><small>${formatDate(photo.created_at)}</small></figcaption></figure>`).join('');
  }

  async function loadParts() {
    const body = $('parts-body'); if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="muted">Carregando...</td></tr>';
    const { data, error } = await db.from('pecas').select('id,codigo,nome,categoria,marca,fabricante,unidade,quantidade_estoque,estoque_minimo,custo_unitario,fornecedor').order('nome', { ascending: true });
    if (error) { body.innerHTML = `<tr><td colspan="7" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    partsCache = data || []; renderParts(); populateMovementSelect(); populateMaintenancePartSelect();
  }

  function renderParts() {
    const query = $('part-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = partsCache.filter((p) => [p.codigo,p.nome,p.categoria,p.marca,p.fabricante].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('parts-body').innerHTML = rows.length ? rows.map((p) => {
      const low = Number(p.quantidade_estoque) <= Number(p.estoque_minimo);
      const actions = canManageParts() ? `<button class="btn btn-outline table-action" data-edit-part="${p.id}">Editar</button><button class="btn btn-outline table-action" data-move-part="${p.id}">Entrada/saída</button>` : '<span class="muted">Somente consulta</span>';
      return `<tr><td>${escapeHtml(p.codigo || '—')}</td><td><strong>${escapeHtml(p.nome)}</strong></td><td>${escapeHtml((p.categoria || '').replaceAll('_',' ') || '—')}</td><td>${escapeHtml([p.marca,p.fabricante].filter(Boolean).join(' / ') || '—')}</td><td><span class="${low ? 'stock-low' : ''}">${formatNumber(p.quantidade_estoque,2)} ${escapeHtml(p.unidade || 'un')}</span></td><td>${formatNumber(p.estoque_minimo,2)}</td><td><div class="table-actions">${actions}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-table">Nenhuma peça cadastrada.</td></tr>';
  }

  function openNewPartDialog() {
    if (!canManageParts()) return showToast('Somente administrador ou almoxarifado pode cadastrar peças.', 'error');
    editingPartId = null; $('part-form').reset(); $('p-stock').readOnly = false; $('p-stock').value = '0'; $('part-dialog-title').textContent = 'Nova peça'; $('part-stock-hint').textContent = 'Informe a quantidade inicial. As próximas entradas e saídas devem ser registradas em Movimentar estoque.'; $('part-error').textContent = ''; $('part-dialog').showModal();
  }
  function openEditPart(id) {
    if (!canManageParts()) return;
    const p = partsCache.find((x) => x.id === id); if (!p) return;
    editingPartId = id; $('part-form').reset(); $('part-dialog-title').textContent = 'Editar peça'; $('p-code').value = p.codigo || ''; $('p-name').value = p.nome || ''; $('p-category').value = p.categoria || 'outros'; $('p-brand').value = p.marca || ''; $('p-manufacturer').value = p.fabricante || ''; $('p-unit').value = p.unidade || 'un'; $('p-stock').value = p.quantidade_estoque ?? 0; $('p-stock').readOnly = true; $('p-minimum').value = p.estoque_minimo ?? 0; $('p-cost').value = p.custo_unitario ?? ''; $('p-supplier').value = p.fornecedor || ''; $('part-stock-hint').textContent = 'O saldo não é alterado nesta tela. Use Movimentar estoque para registrar entradas e saídas.'; $('part-error').textContent = ''; $('part-dialog').showModal();
  }
  async function savePart(event) {
    event.preventDefault(); if (!canManageParts()) return;
    const save = $('save-part'); save.disabled = true; save.textContent = 'Salvando...'; $('part-error').textContent = '';
    const record = { codigo: $('p-code').value.trim() || null, nome: $('p-name').value.trim(), categoria: $('p-category').value, marca: $('p-brand').value.trim() || null, fabricante: $('p-manufacturer').value.trim() || null, unidade: $('p-unit').value, estoque_minimo: Number($('p-minimum').value || 0), custo_unitario: toNullableNumber($('p-cost').value), fornecedor: $('p-supplier').value.trim() || null };
    if (!editingPartId) record.quantidade_estoque = Number($('p-stock').value || 0);
    try {
      const result = editingPartId ? await db.from('pecas').update(record).eq('id', editingPartId) : await db.from('pecas').insert(record);
      if (result.error) throw result.error;
      closeDialog('part-dialog'); await Promise.all([loadParts(), refreshDashboard()]); showToast(editingPartId ? 'Peça atualizada.' : 'Peça cadastrada.', 'success'); editingPartId = null;
    } catch (error) { $('part-error').textContent = friendlyError(error); $('part-error').classList.add('error'); }
    finally { save.disabled = false; save.textContent = 'Salvar peça'; }
  }
  function handlePartAction(event) {
    const edit = event.target.closest('[data-edit-part]'); const move = event.target.closest('[data-move-part]');
    if (edit) openEditPart(edit.dataset.editPart);
    if (move) openMovementDialog(move.dataset.movePart);
  }
  function populateMovementSelect(selectedId = '') {
    $('mv-part').innerHTML = `<option value="">Selecione a peça</option>${partsCache.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(`${p.nome} · saldo ${formatNumber(p.quantidade_estoque,2)} ${p.unidade || 'un'}`)}</option>`).join('')}`;
  }
  function openMovementDialog(partId = '') {
    if (!canManageParts()) return showToast('Somente administrador ou almoxarifado pode movimentar o estoque.', 'error');
    $('movement-form').reset(); $('mv-quantity').value = '1'; $('movement-error').textContent = ''; populateMovementSelect(partId); $('movement-dialog').showModal();
  }
  async function saveMovement(event) {
    event.preventDefault(); if (!canManageParts()) return;
    const save = $('save-movement'); save.disabled = true; save.textContent = 'Registrando...'; $('movement-error').textContent = '';
    try {
      const record = { peca_id: $('mv-part').value, tipo: $('mv-type').value, quantidade: Number($('mv-quantity').value), custo_unitario: toNullableNumber($('mv-cost').value), fornecedor: $('mv-supplier').value.trim() || null, documento: $('mv-document').value.trim() || null, observacao: $('mv-note').value.trim() || null, responsavel_id: currentUser.id };
      if (!record.peca_id) throw new Error('Selecione uma peça.');
      if (!Number.isFinite(record.quantidade) || record.quantidade <= 0) throw new Error('Informe uma quantidade maior que zero.');
      const { error } = await db.from('movimentacoes_estoque').insert(record);
      if (error) throw error;
      closeDialog('movement-dialog'); await Promise.all([loadParts(), refreshDashboard()]); showToast('Movimentação registrada e saldo atualizado.', 'success');
    } catch (error) { $('movement-error').textContent = friendlyError(error); $('movement-error').classList.add('error'); }
    finally { save.disabled = false; save.textContent = 'Registrar movimentação'; }
  }

  async function loadBatteries() {
    const body = $('batteries-body'); if (!body) return;
    body.innerHTML = '<tr><td colspan="8" class="muted">Carregando...</td></tr>';
    const { data, error } = await db.from('baterias').select('id,gerador_id,marca,modelo,numero_serie,capacidade_ah,tensao_v,data_fabricacao,data_instalacao,fim_garantia,situacao,observacoes,geradores(numero)').order('created_at', { ascending: false });
    if (error) { body.innerHTML = `<tr><td colspan="8" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    batteriesCache = data || []; renderBatteries(); populateGeneratorSelects();
  }
  function batteryWarrantyLabel(dateValue) {
    if (!dateValue) return 'Sem data';
    const end = new Date(`${dateValue}T23:59:59`); const days = Math.ceil((end - new Date()) / 86400000);
    if (days < 0) return 'Vencida'; if (days <= 30) return `Vence em ${days} dias`; return 'Vigente';
  }
  function renderBatteries() {
    const query = $('battery-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = batteriesCache.filter((b) => [b.marca,b.modelo,b.numero_serie,b.geradores?.numero,b.situacao].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('batteries-body').innerHTML = rows.length ? rows.map((b) => {
      const warranty = batteryWarrantyLabel(b.fim_garantia);
      const actions = canManageBatteries() ? `<button class="btn btn-outline table-action" data-edit-battery="${b.id}">Editar</button>` : '<span class="muted">Somente consulta</span>';
      return `<tr><td><strong>${escapeHtml([b.marca,b.modelo].filter(Boolean).join(' / ') || 'Bateria')}</strong><small class="table-subline">${b.capacidade_ah ? `${formatNumber(b.capacidade_ah)} Ah` : ''}${b.tensao_v ? ` · ${formatNumber(b.tensao_v)} V` : ''}</small></td><td>${escapeHtml(b.numero_serie || '—')}</td><td>${escapeHtml(b.geradores?.numero ? `Gerador ${b.geradores.numero}` : 'Em estoque')}</td><td>${b.capacidade_ah ? `${formatNumber(b.capacidade_ah)} Ah` : '—'} / ${b.tensao_v ? `${formatNumber(b.tensao_v)} V` : '—'}</td><td>${formatDate(b.data_instalacao)}</td><td><span class="${warranty === 'Vencida' ? 'text-danger' : warranty.startsWith('Vence') ? 'text-warning' : ''}">${formatDate(b.fim_garantia)} · ${escapeHtml(warranty)}</span></td><td><span class="status-pill">${escapeHtml(b.situacao.replace('_',' '))}</span></td><td>${actions}</td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-table">Nenhuma bateria cadastrada.</td></tr>';
  }
  function openNewBatteryDialog() {
    if (!canManageBatteries()) return showToast('Seu perfil não pode cadastrar baterias.', 'error');
    editingBatteryId = null; $('battery-form').reset(); $('battery-dialog-title').textContent = 'Nova bateria'; $('b-status').value = 'em_estoque'; $('battery-error').textContent = ''; populateGeneratorSelects(); $('battery-dialog').showModal();
  }
  function openEditBattery(id) {
    if (!canManageBatteries()) return;
    const b = batteriesCache.find((x) => x.id === id); if (!b) return;
    editingBatteryId = id; $('battery-form').reset(); $('battery-dialog-title').textContent = 'Editar bateria'; $('b-brand').value = b.marca || ''; $('b-model').value = b.modelo || ''; $('b-serial').value = b.numero_serie || ''; $('b-ah').value = b.capacidade_ah ?? ''; $('b-voltage').value = b.tensao_v ?? ''; $('b-manufactured').value = b.data_fabricacao || ''; $('b-installed').value = b.data_instalacao || ''; $('b-warranty').value = b.fim_garantia || ''; $('b-status').value = b.situacao || 'em_estoque'; $('b-generator').value = b.gerador_id || ''; $('b-notes').value = b.observacoes || ''; $('battery-error').textContent = ''; populateGeneratorSelects(); $('b-generator').value = b.gerador_id || ''; $('battery-dialog').showModal();
  }
  async function saveBattery(event) {
    event.preventDefault(); if (!canManageBatteries()) return;
    const save = $('save-battery'); save.disabled = true; save.textContent = 'Salvando...'; $('battery-error').textContent = '';
    try {
      const status = $('b-status').value; const genId = $('b-generator').value;
      if (status === 'instalada' && !genId) throw new Error('Selecione o gerador onde a bateria está instalada.');
      const record = { marca: $('b-brand').value.trim(), modelo: $('b-model').value.trim() || null, numero_serie: $('b-serial').value.trim() || null, capacidade_ah: toNullableNumber($('b-ah').value), tensao_v: toNullableNumber($('b-voltage').value), data_fabricacao: $('b-manufactured').value || null, data_instalacao: $('b-installed').value || null, fim_garantia: $('b-warranty').value || null, situacao: status, gerador_id: status === 'instalada' ? genId : null, observacoes: $('b-notes').value.trim() || null };
      const result = editingBatteryId ? await db.from('baterias').update(record).eq('id', editingBatteryId) : await db.from('baterias').insert(record);
      if (result.error) throw result.error;
      const editing = Boolean(editingBatteryId); editingBatteryId = null; closeDialog('battery-dialog'); await Promise.all([loadBatteries(), refreshDashboard()]); showToast(editing ? 'Bateria atualizada.' : 'Bateria cadastrada.', 'success');
    } catch (error) { $('battery-error').textContent = friendlyError(error); $('battery-error').classList.add('error'); }
    finally { save.disabled = false; save.textContent = 'Salvar bateria'; }
  }
  function handleBatteryAction(event) { const edit = event.target.closest('[data-edit-battery]'); if (edit) openEditBattery(edit.dataset.editBattery); }


  // DMV: locações e entregas. Permissões efetivas são verificadas também pelas RLS do Supabase.
  const rentalAdmin = () => normalizedRole() === 'administrador';
  const rentalTech = () => normalizedRole() === 'tecnico';
  function bindRentalEvents() {
    $('r-new').addEventListener('click', () => openRentalAdmin());
    $('r-admin-form').addEventListener('submit', saveRentalAdmin);
    $('r-delivery-form').addEventListener('submit', saveRentalDelivery);
    $('r-gps').addEventListener('click', captureRentalGPS);
    $('r-search').addEventListener('input', renderRentals);
    $('r-body').addEventListener('click', async e => {
      const b = e.target.closest('button[data-r-action]'); if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.rAction === 'edit') await openRentalAdmin(id);
      if (b.dataset.rAction === 'deliver') openRentalDelivery(id);
      if (b.dataset.rAction === 'detail') await showRentalDetails(id);
    });
  }
  async function loadRentals() {
    const body = $('r-body'); body.innerHTML = '<tr><td colspan="6">Carregando...</td></tr>';
    const {data,error} = await db.from('dmv_locacoes').select('*').order('created_at',{ascending:false});
    if (error) { body.innerHTML = `<tr><td colspan="6" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    rentalsCache = data || []; renderRentals();
  }
  function renderRentals() {
    const q = $('r-search').value.toLowerCase();
    const rows = rentalsCache.filter(r => [r.cliente,r.endereco_previsto,generatorsCache.find(g=>g.id===r.gerador_id)?.numero].some(x=>String(x||'').toLowerCase().includes(q)));
    $('r-body').innerHTML = rows.length ? rows.map(r => {
      const g = generatorsCache.find(x=>x.id===r.gerador_id);
      const actions = [`<button class="btn btn-outline table-action" data-r-action="detail" data-id="${escapeHtml(r.id)}">Detalhes</button>`];
      if (rentalAdmin()) actions.push(`<button class="btn btn-outline table-action" data-r-action="edit" data-id="${escapeHtml(r.id)}">Editar</button>`);
      if ((rentalTech() || rentalAdmin()) && r.situacao==='ativa' && !r.entregue_em && (!r.tecnico_designado || r.tecnico_designado===currentUser.id || rentalAdmin())) actions.push(`<button class="btn btn-primary table-action" data-r-action="deliver" data-id="${escapeHtml(r.id)}">Registrar entrega</button>`);
      return `<tr><td><strong>EA ${escapeHtml(g?.numero||'—')}</strong><small class="table-subline">${g?.potencia_kva==null?'':formatNumber(g.potencia_kva,0)+' kVA'}</small></td><td>${escapeHtml(r.cliente)}</td><td>${formatDate(r.data_saida)} / ${formatDate(r.previsao_retorno)}</td><td>${escapeHtml(r.endereco_previsto||'—')}</td><td><span class="status-pill ${r.situacao==='ativa'?'alugado':'concluida'}">${escapeHtml(r.entregue_em?'Entregue · ':'')}${escapeHtml(r.situacao)}</span></td><td><div class="table-actions">${actions.join('')}</div></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-table">Nenhuma locação encontrada.</td></tr>';
  }
  async function openRentalAdmin(id = null) {
    if (!rentalAdmin()) return showToast('Somente administrador pode editar locações.','error');
    await loadGenerators();
    rentalEditingId=id;
    const r=rentalsCache.find(x=>x.id===id);
    $('r-admin-form').reset(); $('r-admin-error').textContent='';
    $('r-admin-title').textContent=r?'Editar locação':'Nova locação';
    $('r-generator').innerHTML='<option value="">Selecione</option>'+generatorsCache.map(g=>`<option value="${escapeHtml(g.id)}">EA ${escapeHtml(g.numero)} · ${formatNumber(g.potencia_kva,0)} kVA</option>`).join('');
    const {data:techs,error} = await db.from('perfis').select('id,nome').eq('papel','tecnico').eq('ativo',true).order('nome');
    if(error) showToast('Lista de técnicos indisponível; use a opção qualquer técnico autorizado.','error');
    $('r-tech').innerHTML='<option value="">Qualquer técnico autorizado</option>'+(techs||[]).map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.nome)}</option>`).join('');
    $('r-generator').value=r?.gerador_id||''; $('r-client').value=r?.cliente||'';
    $('r-start').value=r?.data_saida||todayISO(); $('r-end').value=r?.previsao_retorno||'';
    $('r-address').value=r?.endereco_previsto||''; $('r-tech').value=r?.tecnico_designado||'';
    $('r-status').value=r?.situacao||'ativa'; $('r-notes').value=r?.observacoes_admin||'';
    $('r-admin-dialog').showModal();
  }
  async function saveRentalAdmin(e) {
    e.preventDefault(); if(!rentalAdmin()) return;
    const btn=$('r-admin-save'); btn.disabled=true; $('r-admin-error').textContent='';
    try {
      const record={gerador_id:$('r-generator').value,cliente:$('r-client').value.trim(),data_saida:$('r-start').value,previsao_retorno:$('r-end').value||null,endereco_previsto:$('r-address').value.trim()||null,tecnico_designado:$('r-tech').value||null,situacao:$('r-status').value,observacoes_admin:$('r-notes').value.trim()||null};
      if(!record.gerador_id||!record.cliente||!record.data_saida) throw new Error('Preencha máquina, cliente e data de saída.');
      if(record.previsao_retorno && record.previsao_retorno<record.data_saida) throw new Error('Previsão de retorno anterior à saída.');
      const result=rentalEditingId?await db.from('dmv_locacoes').update(record).eq('id',rentalEditingId):await db.from('dmv_locacoes').insert({...record,criado_por:currentUser.id});
      if(result.error) throw result.error;
      closeDialog('r-admin-dialog'); await loadRentals(); showToast('Locação salva.','success');
    } catch(err) {$('r-admin-error').textContent=friendlyError(err);} finally {btn.disabled=false;}
  }
  function openRentalDelivery(id) {
    const r=rentalsCache.find(x=>x.id===id);
    if(!r||r.situacao!=='ativa'||r.entregue_em||(!rentalTech()&&!rentalAdmin())||(r.tecnico_designado&&r.tecnico_designado!==currentUser.id&&!rentalAdmin())) return showToast('Entrega indisponível para este usuário.','error');
    rentalDeliveryId=id; rentalGpsCaptured=false;
    $('r-delivery-form').reset(); $('r-delivery-error').textContent='';
    $('r-lat').value=''; $('r-lng').value=''; $('r-gps-message').textContent='Toque em Capturar GPS e autorize a localização.';
    $('r-delivery-address').value=r.endereco_previsto||'';
    const g=generatorsCache.find(x=>x.id===r.gerador_id);
    $('r-delivery-summary').textContent=`EA ${g?.numero||'—'} · ${r.cliente}`;
    $('r-hours').value=g?.horimetro_atual??'';
    $('r-delivery-dialog').showModal();
  }
  async function captureRentalGPS() {
    const message=$('r-gps-message'); rentalGpsCaptured=false; $('r-lat').value=''; $('r-lng').value='';
    if(!navigator.geolocation) return message.textContent='Este dispositivo não oferece GPS pelo navegador.';
    if(!window.isSecureContext) return message.textContent='GPS exige HTTPS. Abra o aplicativo no endereço seguro.';
    message.textContent='Buscando localização... aguarde ao ar livre, se possível.';
    navigator.geolocation.getCurrentPosition(async pos=>{
      if(!$('r-delivery-dialog').open) return;
      const lat=pos.coords.latitude, lng=pos.coords.longitude;
      $('r-lat').value=lat.toFixed(7); $('r-lng').value=lng.toFixed(7); rentalGpsCaptured=true;
      message.textContent=`GPS capturado (precisão aproximada: ${Math.round(pos.coords.accuracy)} metros). Conferir endereço antes de salvar.`;
      try {
        const response=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=pt-BR`,{headers:{'Accept':'application/json'}});
        if(response.ok) { const place=await response.json(); if(place.display_name) $('r-delivery-address').value=place.display_name; }
      } catch(_) { message.textContent+=' Não foi possível identificar endereço; preencha manualmente.'; }
    },err=>{message.textContent=err.code===1?'Localização negada. Autorize o acesso nas configurações do navegador.':'GPS indisponível. Verifique sinal e tente novamente.';},{enableHighAccuracy:true,timeout:20000,maximumAge:0});
  }
  async function saveRentalDelivery(e) {
    e.preventDefault(); const btn=$('r-delivery-save'); btn.disabled=true; $('r-delivery-error').textContent='';
    try {
      if(!rentalGpsCaptured) throw new Error('Capture o GPS antes de finalizar.');
      const photos=Array.from($('r-photos').files||[]);
      if(!photos.length) throw new Error('Anexe ao menos uma foto.');
      for(const f of photos) if(!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>10*1024*1024) throw new Error(`Foto ${f.name}: use JPG/PNG/WEBP até 10 MB.`);
      const hours=Number($('r-hours').value); if(!Number.isFinite(hours)||hours<0) throw new Error('Horímetro inválido.');
      const payload={p_locacao_id:rentalDeliveryId,p_horimetro:hours,p_condicao:$('r-condition').value,p_endereco:$('r-delivery-address').value.trim(),p_latitude:Number($('r-lat').value),p_longitude:Number($('r-lng').value),p_observacoes:$('r-delivery-notes').value.trim()||null};
      if(!payload.p_endereco) throw new Error('Informe o endereço da entrega.');
      const {data,error}=await db.rpc('dmv_registrar_entrega_locacao',payload);
      if(error) throw error;
      // A entrega já foi gravada; upload pode ser retomado pela administração se houver falha.
      let uploaded=0, failures=[];
      for(const f of photos) {
        const ext=f.type==='image/png'?'png':f.type==='image/webp'?'webp':'jpg';
        const path=`${rentalDeliveryId}/${crypto.randomUUID()}.${ext}`;
        const up=await db.storage.from('fotos-locacoes').upload(path,f,{contentType:f.type,upsert:false});
        if(up.error) {failures.push(f.name+': '+friendlyError(up.error)); continue;}
        const row=await db.from('dmv_fotos_locacao').insert({locacao_id:rentalDeliveryId,caminho_storage:path,legenda:f.name,enviado_por:currentUser.id});
        if(row.error) failures.push(f.name+': '+friendlyError(row.error)); else uploaded++;
      }
      closeDialog('r-delivery-dialog'); await loadRentals();
      if(failures.length) showToast(`Entrega registrada, mas ${failures.length} foto(s) falharam. Avise o administrador.`, 'error');
      else showToast(`Entrega registrada com GPS e ${uploaded} foto(s).`,'success');
    } catch(err) {$('r-delivery-error').textContent=friendlyError(err);} finally {btn.disabled=false;}
  }
  async function showRentalDetails(id) {
    const r=rentalsCache.find(x=>x.id===id); if(!r) return;
    const g=generatorsCache.find(x=>x.id===r.gerador_id);
    const target=$('r-detail-content'); target.textContent='Carregando...'; $('r-detail-dialog').showModal();
    const {data:photos,error}=await db.from('dmv_fotos_locacao').select('caminho_storage,legenda').eq('locacao_id',id);
    const signed=await Promise.all((photos||[]).map(async p=>{
      const res=await db.storage.from('fotos-locacoes').createSignedUrl(p.caminho_storage,3600);
      return {...p,url:res.error?null:res.data?.signedUrl};
    }));
    const maps= r.latitude!=null&&r.longitude!=null?`<a target="_blank" rel="noopener noreferrer" class="r-map" href="https://www.google.com/maps?q=${encodeURIComponent(r.latitude+','+r.longitude)}">📍 Abrir GPS no Google Maps</a>`:'GPS ainda não registrado';
    target.innerHTML=`<div class="r-detail"><p><strong>Máquina:</strong> EA ${escapeHtml(g?.numero||'—')} · ${g?.potencia_kva==null?'':formatNumber(g.potencia_kva,0)+' kVA'}</p><p><strong>Cliente:</strong> ${escapeHtml(r.cliente)}</p><p><strong>Período:</strong> ${formatDate(r.data_saida)} a ${formatDate(r.previsao_retorno)}</p><p><strong>Situação:</strong> ${escapeHtml(r.situacao)}</p><p><strong>Endereço previsto:</strong> ${escapeHtml(r.endereco_previsto||'—')}</p><p><strong>Entregue em:</strong> ${r.entregue_em?new Date(r.entregue_em).toLocaleString('pt-BR'):'Aguardando'}</p><p><strong>Horímetro na entrega:</strong> ${formatNumber(r.horimetro_entrega)} h</p><p><strong>Condição:</strong> ${escapeHtml(r.condicao_entrega||'—')}</p><p><strong>Endereço confirmado:</strong> ${escapeHtml(r.endereco_entrega||'—')}</p><p>${maps}</p><p><strong>Observações:</strong> ${escapeHtml(r.observacoes_entrega||'—')}</p><h4>Fotos da entrega</h4>${error?`<p class="error-cell">${escapeHtml(friendlyError(error))}</p>`:''}<div class="r-photo-grid">${signed.map(p=>p.url?`<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(p.url)}"><img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.legenda||'Foto da entrega')}" loading="lazy"></a>`:'<span>Foto indisponível</span>').join('')||'<p>Sem fotos anexadas.</p>'}</div></div>`;
  }

  function closeDialog(id) { const dialog = $(id); if (dialog?.open) dialog.close(); }

  init();
})();
