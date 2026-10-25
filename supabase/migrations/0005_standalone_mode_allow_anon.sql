-- スタンドアロン運用（ログインなし）：未ログイン(anon)にも全データの読み書きを許可する
-- ログインを導入するときは、このマイグレーションの anon ポリシーを削除する
do $$
declare t text;
begin
  foreach t in array array['profiles', 'companies', 'periods', 'issues', 'journal_categories',
                           'group_accounts', 'account_mappings', 'column_mappings', 'asset_class_rules',
                           'policies', 'source_files', 'detail_items', 'field_reviews', 'item_key_links',
                           'calculation_runs', 'calculation_steps', 'item_balances', 'journal_entries',
                           'journal_lines', 'btrex_opening_balances', 'work_status'] loop
    execute format('create policy %I on %I for all to anon using (true) with check (true)',
                   t || '_anon', t);
  end loop;
end $$;

create policy change_logs_read_anon on change_logs for select to anon using (true);

create policy source_files_anon on storage.objects for all to anon
  using (bucket_id = 'source-files') with check (bucket_id = 'source-files');

-- ログインなしでは担当者IDを持てないため、確認者・確定者は任意にする（日時は必須のまま）
alter table detail_items drop constraint detail_items_check;
alter table detail_items add constraint detail_items_check
  check ((review_status = 'checked') = (checked_at is not null));
alter table work_status drop constraint work_status_check;
alter table work_status add constraint work_status_check
  check ((status = 'locked') = (locked_at is not null));
