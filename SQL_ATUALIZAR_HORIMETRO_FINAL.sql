-- DMV ENGENHARIA - GARANTIR GRAVACAO DO HORIMETRO FINAL
-- Execute no Supabase > SQL Editor > New Query > Run.
-- Nao apaga ordens, geradores, fotos ou pecas existentes.

begin;

alter table public.ordens_manutencao
  add column if not exists horimetro_final numeric(12,1);

create or replace function public.dmv_atualizar_gerador_apos_conclusao_os()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'concluida'
     and (old.status is distinct from new.status
          or old.horimetro_final is distinct from new.horimetro_final) then
    update public.geradores
       set horimetro_atual = greatest(
             coalesce(horimetro_atual, 0),
             coalesce(new.horimetro_final, new.horimetro, 0)
           ),
           ultima_preventiva_em = case
             when new.tipo = 'preventiva'
               then coalesce(new.data_conclusao::date, current_date)
             else ultima_preventiva_em
           end,
           ultima_preventiva_horimetro = case
             when new.tipo = 'preventiva'
               then coalesce(new.horimetro_final, new.horimetro)
             else ultima_preventiva_horimetro
           end
     where id = new.gerador_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dmv_horimetro_por_os on public.ordens_manutencao;
drop trigger if exists trg_preventiva_concluida on public.ordens_manutencao;
drop trigger if exists trg_dmv_horimetro_final_conclusao on public.ordens_manutencao;

create trigger trg_dmv_horimetro_final_conclusao
after update of status, horimetro_final on public.ordens_manutencao
for each row
execute function public.dmv_atualizar_gerador_apos_conclusao_os();

notify pgrst, 'reload schema';
commit;

select 'DMV: horimetro final e atualizacao do gerador configurados.' as resultado;
