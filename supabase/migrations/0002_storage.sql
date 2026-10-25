
-- 元資料の保存先（非公開）
insert into storage.buckets (id, name, public) values ('source-files', 'source-files', false);
create policy source_files_authenticated on storage.objects for all to authenticated
  using (bucket_id = 'source-files') with check (bucket_id = 'source-files');
