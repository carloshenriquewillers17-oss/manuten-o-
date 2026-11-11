-- DMV ENGENHARIA - EXCLUSAO DE ORDEM DE SERVICO PELO ADMINISTRADOR
-- A funcao valida o perfil no banco, devolve pecas ao estoque e apaga os registros
-- relacionados. Os arquivos fisicos das fotos sao removidos pelo aplicativo via Storage.

begin;

create or replace function public.dmv_excluir_ordem_servico(p_ordem_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $dmv$
declare
  v_papel text;
  v_numero_os bigint;
  v_foto_paths text[] := array[]::text[];
  v_itens_count bigint := 0;
  v_saidas_count bigint := 0;
begin
  -- Validacao obrigatoria no servidor: somente administrador ativo pode excluir.
  select p.papel
    into v_papel
    from public.perfis as p
   where p.id = auth.uid()
     and p.ativo = true;

  if v_papel is distinct from 'administrador' then
    raise exception 'Somente o administrador ativo da DMV pode excluir ordens de servico.';
  end if;

  -- Bloqueia a OS durante a exclusao e confirma que ela existe.
  select os.numero_os
    into v_numero_os
    from public.ordens_manutencao as os
   where os.id = p_ordem_id
   for update;

  if not found then
    raise exception 'Ordem de servico nao encontrada.';
  end if;

  -- Guarda os caminhos para o aplicativo remover os arquivos do bucket privado.
  select coalesce(array_agg(f.caminho_storage), array[]::text[])
    into v_foto_paths
    from public.fotos_manutencao as f
   where f.ordem_id = p_ordem_id;

  -- Recompõe o estoque usando os itens efetivamente lançados na OS.
  select count(*)
    into v_itens_count
    from public.itens_manutencao as i
   where i.ordem_id = p_ordem_id;

  if v_itens_count > 0 then
    update public.pecas as p
       set quantidade_estoque = coalesce(p.quantidade_estoque, 0) + consumido.quantidade
      from (
        select i.peca_id, sum(i.quantidade) as quantidade
          from public.itens_manutencao as i
         where i.ordem_id = p_ordem_id
         group by i.peca_id
      ) as consumido
     where p.id = consumido.peca_id;
  else
    -- Compatibilidade com registros antigos que tenham saida vinculada a OS,
    -- mas nao tenham uma linha correspondente em itens_manutencao.
    select count(*)
      into v_saidas_count
      from public.movimentacoes_estoque as m
     where m.ordem_id = p_ordem_id
       and m.tipo = 'saida';

    if v_saidas_count > 0 then
      update public.pecas as p
         set quantidade_estoque = coalesce(p.quantidade_estoque, 0) + consumido.quantidade
        from (
          select m.peca_id, sum(m.quantidade) as quantidade
            from public.movimentacoes_estoque as m
           where m.ordem_id = p_ordem_id
             and m.tipo = 'saida'
           group by m.peca_id
        ) as consumido
       where p.id = consumido.peca_id;
    end if;
  end if;

  -- Remove movimentos vinculados antes da OS para respeitar a chave estrangeira.
  delete from public.movimentacoes_estoque
   where ordem_id = p_ordem_id;

  -- Itens e registros de fotos vinculados sao removidos por ON DELETE CASCADE.
  delete from public.ordens_manutencao
   where id = p_ordem_id;

  return jsonb_build_object(
    'ordem_id', p_ordem_id,
    'numero_os', v_numero_os,
    'foto_paths', to_jsonb(v_foto_paths)
  );
end;
$dmv$;

revoke all on function public.dmv_excluir_ordem_servico(uuid) from public;
revoke all on function public.dmv_excluir_ordem_servico(uuid) from anon;
grant execute on function public.dmv_excluir_ordem_servico(uuid) to authenticated;

grant usage on schema public to authenticated;

notify pgrst, 'reload schema';

commit;

select 'DMV: exclusao de OS habilitada somente para administrador.' as resultado;
