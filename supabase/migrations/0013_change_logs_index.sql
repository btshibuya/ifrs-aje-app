-- 変更履歴の検索を速くする（テストデータの入れ直しで件数が増えても、記録の表示・検証レポートが時間切れにならないように）
create index if not exists change_logs_record_idx on change_logs (table_name, record_id, changed_at);
create index if not exists change_logs_table_id_idx on change_logs (table_name, id desc);
