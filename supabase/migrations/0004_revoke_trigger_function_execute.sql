-- トリガー用の関数を API から直接呼び出せないようにする（セキュリティアドバイザーの指摘対応）
revoke execute on function public.log_change() from public, anon, authenticated;
revoke execute on function public.assert_not_locked() from public, anon, authenticated;
