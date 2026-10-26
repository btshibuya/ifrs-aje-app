-- 画面用のビューに期の種類（Q1・Q2・Q3・FY）を足す
-- 四半期を追加してビューの行数が1000行（APIの上限）を超えたため、画面は時点の種類で絞って読む
-- （マスタの読み込みと同時に問い合わせられ、表示が遅くならない）

create or replace view v_policy_matrix with (security_invoker = true) as
select c.code  as company_code,
       c.name  as company_name,
       p.id    as period_id,
       p.label as period_label,
       i.no    as issue_no,
       i.code  as issue_code,
       i.name  as issue_name,
       coalesce(cp.applicability, gp.applicability) as applicability,
       coalesce(gp.params, '{}') || coalesce(cp.params, '{}') as params,
       coalesce(cp.reason, gp.reason) as reason,
       cp.id is not null as is_company_override,
       p.period_type
  from companies c
  join periods p on p.company_id = c.id
  cross join issues i
  left join lateral (
        select * from policies x
         where x.company_id = c.id and x.issue_code = i.code and x.effective_from <= p.end_date
         order by x.effective_from desc limit 1) cp on true
  left join lateral (
        select * from policies x
         where x.company_id is null and x.issue_code = i.code and x.effective_from <= p.end_date
         order by x.effective_from desc limit 1) gp on true;

create or replace view v_impact_summary with (security_invoker = true) as
select c.code  as company_code,
       p.id    as period_id,
       p.label as period_label,
       e.issue_code,
       a.statement,
       sum(case l.side when 'debit' then l.amount else -l.amount end) as net_debit,
       p.period_type
  from journal_entries e
  join calculation_runs r on r.id = e.run_id and r.status in ('draft', 'final')
  join journal_lines l    on l.entry_id = e.id
  join group_accounts a   on a.code = l.group_account_code
  join periods p          on p.id = e.period_id
  join companies c        on c.id = p.company_id
 group by c.code, p.id, p.label, e.issue_code, a.statement, p.period_type;

create or replace view v_progress with (security_invoker = true) as
select c.code  as company_code,
       p.id    as period_id,
       p.label as period_label,
       i.no    as issue_no,
       i.code  as issue_code,
       coalesce(w.status, 'not_started') as status,
       w.locked_at,
       w.updated_at,
       p.period_type
  from companies c
  join periods p on p.company_id = c.id
  cross join issues i
  left join work_status w on w.period_id = p.id and w.issue_code = i.code;
