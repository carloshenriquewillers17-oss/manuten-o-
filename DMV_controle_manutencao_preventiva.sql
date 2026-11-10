-- DMV ENGENHARIA - CONTROLE DE MANUTENCAO PREVENTIVA
-- Execute no Supabase > SQL Editor > New Query.
-- Nao apaga registros. Mantem as politicas RLS existentes.

-- Garante os campos usados pelo painel de preventivas.
alter table public.geradores
  add column if not exists ultima_preventiva_em date,
  add column if not exists ultima_preventiva_horimetro numeric(12,1);

-- Atualiza automaticamente o horimetro cadastrado do gerador quando uma OS
-- registrar um valor maior. SECURITY DEFINER permite que tecnicos (sem
-- permissao para editar o cadastro principal) atualizem o horimetro pela OS.
create or replace function public.dmv_atualizar_horimetro_por_os()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.horimetro is not null then
    update public.geradores
       set horimetro_atual = greatest(coalesce(horimetro_atual, 0), new.horimetro)
     where id = new.gerador_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dmv_horimetro_por_os on public.ordens_manutencao;
create trigger trg_dmv_horimetro_por_os
after insert or update of horimetro on public.ordens_manutencao
for each row execute function public.dmv_atualizar_horimetro_por_os();

-- Garante que uma preventiva concluida reinicie o ciclo por data e horimetro.
create or replace function public.dmv_registrar_preventiva_concluida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tipo = 'preventiva' and new.status = 'concluida' then
    if tg_op = 'INSERT' or old.status is distinct from new.status then
      update public.geradores
         set ultima_preventiva_em = coalesce(new.data_conclusao::date, current_date),
             ultima_preventiva_horimetro = new.horimetro
       where id = new.gerador_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_preventiva_concluida on public.ordens_manutencao;
create trigger trg_preventiva_concluida
after insert or update of status on public.ordens_manutencao
for each row execute function public.dmv_registrar_preventiva_concluida();

create index if not exists idx_dmv_geradores_preventiva
  on public.geradores(ultima_preventiva_em, ultima_preventiva_horimetro);

notify pgrst, 'reload schema';

select 'DMV: controle de horimetro e preventiva configurado.' as resultado;
