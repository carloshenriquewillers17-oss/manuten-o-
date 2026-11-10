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
  let maintenanceParts = [];

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
  const roleLabel = (role) => ({ administrador: 'Administrador', tecnico: 'Técnico', almoxarifado: 'Almoxarifado' }[role] || 'Usuário');
  const canMaintain = () => ['administrador', 'tecnico'].includes(currentProfile?.papel);
  const canManageParts = () => ['administrador', 'almoxarifado'].includes(currentProfile?.papel);
  const canManageBatteries = () => ['administrador', 'tecnico', 'almoxarifado'].includes(currentProfile?.papel);
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
    $('m-add-part').addEventListener('click', addMaintenancePart);

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
    $('add-generator-button').classList.toggle('hidden', currentProfile.papel !== 'administrador');
    $('add-part-button').classList.toggle('hidden', !canManageParts());
    $('add-movement-button').classList.toggle('hidden', !canManageParts());
    $('add-battery-button').classList.toggle('hidden', !canManageBatteries());
    $('add-maintenance-button').classList.toggle('hidden', !canMaintain());
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
    const { data, error } = await db.from('ordens_manutencao').select('id,numero_os,gerador_id,tipo,status,data_abertura,data_conclusao,horimetro,descricao,geradores(numero)').order('data_abertura', { ascending: false });
    if (error) { body.innerHTML = `<tr><td colspan="7" class="error-cell">${escapeHtml(friendlyError(error))}</td></tr>`; return; }
    maintenanceCache = data || []; renderMaintenance();
  }

  function renderMaintenance() {
    const query = $('maintenance-search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = maintenanceCache.filter((m) => [m.numero_os,m.geradores?.numero,m.descricao,m.tipo,m.status].some((v) => String(v || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('maintenance-body').innerHTML = rows.length ? rows.map((m) => {
      const actions = [`<button type="button" class="btn btn-outline table-action" data-os-details="${m.id}">Ver OS</button>`, `<button type="button" class="btn btn-outline table-action" data-os-photos="${m.id}">Fotos</button>`];
      if (canMaintain() && m.status === 'aberta') actions.push(`<button type="button" class="btn btn-outline table-action" data-os-start="${m.id}">Iniciar</button>`);
      if (canMaintain() && m.status === 'em_andamento') actions.push(`<button type="button" class="btn btn-primary table-action" data-os-finish="${m.id}">Concluir</button>`);
      return `<tr><td><strong>#${escapeHtml(m.numero_os)}</strong></td><td>${escapeHtml(m.geradores?.numero ? `Gerador ${m.geradores.numero}` : '—')}</td><td>${escapeHtml(m.tipo)}</td><td>${formatDate(m.data_abertura)}</td><td>${formatNumber(m.horimetro)}</td><td><span class="status-pill ${escapeHtml(m.status)}">${escapeHtml(m.status.replace('_',' '))}</span></td><td><div class="table-actions">${actions.join('')}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-table">Nenhuma manutenção cadastrada.</td></tr>';
  }

  function openMaintenanceDialog() {
    if (!canMaintain()) return showToast('Seu perfil não pode abrir ordens de manutenção.', 'error');
    if (!generatorsCache.length) return showToast('Cadastre um gerador antes de abrir uma manutenção.', 'error');
    maintenanceParts = []; $('maintenance-form').reset(); $('m-date').value = todayISO(); $('m-part-quantity').value = '1'; $('maintenance-error').textContent = ''; populateGeneratorSelects(); renderSelectedMaintenanceParts(); populateMaintenancePartSelect(); $('maintenance-dialog').showModal();
  }

  function populateMaintenancePartSelect() {
    $('m-part-select').innerHTML = `<option value="">Selecione uma peça</option>${partsCache.map((p) => `<option value="${p.id}">${escapeHtml(`${p.nome} · estoque ${formatNumber(p.quantidade_estoque,2)} ${p.unidade || 'un'}`)}</option>`).join('')}`;
  }

  function addMaintenancePart() {
    const id = $('m-part-select').value; const qty = Number($('m-part-quantity').value);
    const part = partsCache.find((p) => p.id === id);
    if (!part) return showToast('Selecione uma peça cadastrada.', 'error');
    if (!Number.isFinite(qty) || qty <= 0) return showToast('Informe uma quantidade válida.', 'error');
    const existing = maintenanceParts.find((item) => item.peca_id === id);
    if (existing) existing.quantidade += qty; else maintenanceParts.push({ peca_id: id, nome: part.nome, unidade: part.unidade || 'un', quantidade: qty, custo_unitario: part.custo_unitario });
    renderSelectedMaintenanceParts();
  }

  function renderSelectedMaintenanceParts() {
    const box = $('m-selected-parts');
    if (!maintenanceParts.length) { box.className = 'selected-list empty-state'; box.textContent = 'Nenhuma peça adicionada.'; return; }
    box.className = 'selected-list';
    box.innerHTML = maintenanceParts.map((item, index) => `<div class="selected-item"><span>${escapeHtml(item.nome)} · ${formatNumber(item.quantidade,2)} ${escapeHtml(item.unidade)}</span><button type="button" class="btn btn-outline table-action" data-remove-maint-part="${index}">Remover</button></div>`).join('');
    box.querySelectorAll('[data-remove-maint-part]').forEach((button) => button.addEventListener('click', () => { maintenanceParts.splice(Number(button.dataset.removeMaintPart), 1); renderSelectedMaintenanceParts(); }));
  }

  async function saveMaintenance(event) {
    event.preventDefault(); if (!canMaintain()) return;
    const save = $('save-maintenance'); save.disabled = true; save.textContent = 'Salvando...'; $('maintenance-error').textContent = '';
    let createdOrder = null;
    try {
      const generatorId = $('m-generator').value;
      if (!generatorId) throw new Error('Selecione o gerador da manutenção.');
      for (const item of maintenanceParts) {
        const part = partsCache.find((p) => p.id === item.peca_id);
        if (part && Number(part.quantidade_estoque) < item.quantidade) throw new Error(`Estoque insuficiente para ${part.nome}. Disponível: ${formatNumber(part.quantidade_estoque,2)}.`);
      }
      const selectedDate = $('m-date').value;
      const record = { gerador_id: generatorId, tipo: $('m-type').value, status: 'aberta', horimetro: Number($('m-hours').value), descricao: $('m-description').value.trim(), servicos_realizados: $('m-services').value.trim() || null, observacoes: $('m-notes').value.trim() || null, tecnico_id: currentUser.id, created_by: currentUser.id };
      if (selectedDate) record.data_abertura = new Date(`${selectedDate}T12:00:00`).toISOString();
      const result = await db.from('ordens_manutencao').insert(record).select('id,numero_os').single();
      if (result.error) throw result.error;
      createdOrder = result.data;
      for (const item of maintenanceParts) {
        const part = partsCache.find((p) => p.id === item.peca_id);
        const itemResult = await db.from('itens_manutencao').insert({ ordem_id: createdOrder.id, peca_id: item.peca_id, quantidade: item.quantidade, custo_unitario: item.custo_unitario });
        if (itemResult.error) throw new Error(`A OS #${createdOrder.numero_os} foi criada, mas não foi possível lançar a peça ${part?.nome || ''}: ${friendlyError(itemResult.error)}`);
      }
      const photoSummary = await uploadMaintenancePhotos(createdOrder.id);
      closeDialog('maintenance-dialog'); $('maintenance-form').reset(); maintenanceParts = [];
      await Promise.all([loadMaintenance(), loadParts(), loadGenerators(), refreshDashboard()]);
      showToast(`Manutenção OS #${createdOrder.numero_os} salva.${photoSummary ? ` ${photoSummary}` : ''}`, 'success');
    } catch (error) {
      $('maintenance-error').textContent = friendlyError(error); $('maintenance-error').classList.add('error');
      if (createdOrder) showToast(`A OS #${createdOrder.numero_os} foi criada. Confira os itens/fotos: ${friendlyError(error)}`, 'error');
    } finally { save.disabled = false; save.textContent = 'Salvar manutenção'; }
  }

  async function uploadMaintenancePhotos(orderId) {
    const groups = [
      { id: 'm-photos-before', stage: 'antes' },
      { id: 'm-photos-during', stage: 'durante' },
      { id: 'm-photos-after', stage: 'depois' }
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
    const details = event.target.closest('[data-os-details]');
    const photos = event.target.closest('[data-os-photos]');
    const start = event.target.closest('[data-os-start]');
    const finish = event.target.closest('[data-os-finish]');
    if (details) await showMaintenanceDetails(details.dataset.osDetails);
    if (photos) await showMaintenancePhotos(photos.dataset.osPhotos);
    if (start) await updateMaintenanceStatus(start.dataset.osStart, 'em_andamento');
    if (finish) await updateMaintenanceStatus(finish.dataset.osFinish, 'concluida');
  }

  async function showMaintenanceDetails(orderId) {
    const target = $('maintenance-detail-content');
    target.innerHTML = '<p class="muted">Carregando dados da ordem...</p>';
    $('maintenance-detail-title').textContent = `Ordem de serviço #${maintenanceCache.find((m) => m.id === orderId)?.numero_os || ''}`;
    $('maintenance-detail-dialog').showModal();
    const { data, error } = await db.from('ordens_manutencao')
      .select('id,numero_os,tipo,status,data_abertura,data_conclusao,horimetro,descricao,servicos_realizados,observacoes,geradores(numero,marca,modelo,potencia_kva),itens_manutencao(quantidade,custo_unitario,pecas(nome,codigo,unidade))')
      .eq('id', orderId).single();
    if (error) { target.textContent = friendlyError(error); return; }
    const parts = data.itens_manutencao || [];
    target.innerHTML = `<div class="detail-grid">
      <div><small>Gerador</small><strong>${escapeHtml(data.geradores?.numero ? `Nº ${data.geradores.numero}` : '—')}</strong><span>${escapeHtml([data.geradores?.marca,data.geradores?.modelo].filter(Boolean).join(' / '))}</span></div>
      <div><small>Tipo / status</small><strong>${escapeHtml(data.tipo)} · ${escapeHtml(data.status.replaceAll('_',' '))}</strong></div>
      <div><small>Data de abertura</small><strong>${formatDate(data.data_abertura)}</strong></div>
      <div><small>Conclusão</small><strong>${formatDate(data.data_conclusao)}</strong></div>
      <div><small>Horímetro registrado</small><strong>${formatNumber(data.horimetro)} h</strong></div>
      <div class="detail-wide"><small>Descrição / defeito</small><p>${escapeHtml(data.descricao || '—')}</p></div>
      <div class="detail-wide"><small>Serviços realizados</small><p>${escapeHtml(data.servicos_realizados || 'Não informado')}</p></div>
      <div class="detail-wide"><small>Observações</small><p>${escapeHtml(data.observacoes || '—')}</p></div>
      <div class="detail-wide"><small>Peças utilizadas</small>${parts.length ? `<ul>${parts.map((item) => `<li>${escapeHtml(item.pecas?.nome || 'Peça')} — ${formatNumber(item.quantidade,2)} ${escapeHtml(item.pecas?.unidade || 'un')}${item.pecas?.codigo ? ` · cód. ${escapeHtml(item.pecas.codigo)}` : ''}</li>`).join('')}</ul>` : '<p>Nenhuma peça lançada nesta OS.</p>'}</div>
    </div><div class="detail-actions"><button type="button" class="btn btn-outline" data-detail-photos="${data.id}">Ver fotos desta OS</button></div>`;
    target.querySelector('[data-detail-photos]')?.addEventListener('click', () => { closeDialog('maintenance-detail-dialog'); showMaintenancePhotos(orderId); });
  }

  async function updateMaintenanceStatus(id, status) {
    const order = maintenanceCache.find((item) => item.id === id); if (!order) return;
    const prompt = status === 'concluida' ? 'Confirma a conclusão desta manutenção?' : 'Deseja iniciar esta manutenção?';
    if (!window.confirm(prompt)) return;
    const patch = { status };
    if (status === 'concluida') patch.data_conclusao = new Date().toISOString();
    const { error } = await db.from('ordens_manutencao').update(patch).eq('id', id);
    if (error) return showToast(friendlyError(error), 'error');
    await Promise.all([loadMaintenance(), loadGenerators(), refreshDashboard()]);
    showToast(status === 'concluida' ? 'Manutenção concluída.' : 'Manutenção iniciada.', 'success');
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

  function closeDialog(id) { const dialog = $(id); if (dialog?.open) dialog.close(); }

  init();
})();
