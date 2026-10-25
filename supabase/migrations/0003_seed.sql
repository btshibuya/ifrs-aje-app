-- =====================================================================
-- 初期データ：15論点と仕訳区分
-- 仕訳区分の方式（carry_method）はBTrexの設定に合わせてあとから変更できる
-- =====================================================================

insert into issues (code, no, name, standard_ref) values
  ('PAID_LEAVE',        1, '有給休暇引当金',                     'IAS19'),
  ('LEVY',              2, '賦課金（固定資産税・均等割）',       'IFRIC21'),
  ('DEPRECIATION',      3, '減価償却（経済的耐用年数）',         'IAS16'),
  ('LEASE',             4, 'リース（借手）',                     'IFRS16'),
  ('PRESENTATION',      5, '特別損益の廃止・税金科目の組替え',   'IAS1'),
  ('RETIREMENT_1',      6, '退職給付①（即時認識・純利息）',     'IAS19'),
  ('RETIREMENT_2',      7, '退職給付②（割引率・期間帰属）',     'IAS19'),
  ('EQUITY_INSTRUMENT', 8, '金融商品（株式）',                   'IFRS9'),
  ('GOODWILL',          9, 'のれんの非償却',                     'IFRS3, IAS36'),
  ('COMPRESSION',      10, '圧縮記帳の取消し',                   'IAS20, IAS16'),
  ('ARO',              11, '資産除去債務の割引率',               'IAS37, IFRIC1'),
  ('SHARE_BASED',      12, '株式報酬費用',                       'IFRS2'),
  ('EIR',              13, '借入手数料の実効金利法',             'IFRS9'),
  ('DEVELOPMENT',      14, '開発費・繰延資産',                   'IAS38'),
  ('TAX_EFFECT',       15, '税効果（回収可能性・税率差異）',     'IAS12');

insert into journal_categories (code, issue_code, name, carry_method, is_tax_effect, sort_order) values
  ('PAID_LEAVE_MAIN',       'PAID_LEAVE',        '有給休暇引当金',               'reversing',  false, 101),
  ('PAID_LEAVE_TAX',        'PAID_LEAVE',        '有給休暇引当金（税効果）',     'reversing',  true,  102),
  ('LEVY_PROPERTY_TAX',     'LEVY',              '固定資産税',                   'reversing',  false, 201),
  ('LEVY_PROPERTY_TAX_TAX', 'LEVY',              '固定資産税（税効果）',         'reversing',  true,  202),
  ('LEVY_PER_CAPITA',       'LEVY',              '均等割の組替え',               'reclass',    false, 203),
  ('DEPR_MAIN',             'DEPRECIATION',      '減価償却',                     'cumulative', false, 301),
  ('DEPR_TAX',              'DEPRECIATION',      '減価償却（税効果）',           'cumulative', true,  302),
  ('LEASE_MAIN',            'LEASE',             '使用権資産・リース負債',       'cumulative', false, 401),
  ('LEASE_CURRENT',         'LEASE',             'リース負債の流動・非流動区分', 'reversing',  false, 402),
  ('LEASE_TAX',             'LEASE',             'リース（税効果）',             'cumulative', true,  403),
  ('PRES_EXTRAORDINARY',    'PRESENTATION',      '特別損益の組替え',             'reclass',    false, 501),
  ('PRES_TAX_ACCOUNT',      'PRESENTATION',      '外形標準課税の組替え',         'reclass',    false, 502),
  ('RET1_MAIN',             'RETIREMENT_1',      '退職給付（即時認識・純利息）', 'cumulative', false, 601),
  ('RET1_TAX',              'RETIREMENT_1',      '退職給付①（税効果）',         'cumulative', true,  602),
  ('RET2_MAIN',             'RETIREMENT_2',      '退職給付（割引率・期間帰属）', 'cumulative', false, 701),
  ('RET2_TAX',              'RETIREMENT_2',      '退職給付②（税効果）',         'cumulative', true,  702),
  ('EQ_MAIN',               'EQUITY_INSTRUMENT', '株式の公正価値評価',           'cumulative', false, 801),
  ('EQ_TAX',                'EQUITY_INSTRUMENT', '株式（税効果）',               'cumulative', true,  802),
  ('GOODWILL_MAIN',         'GOODWILL',          'のれん償却の戻入れ',           'cumulative', false, 901),
  ('COMP_MAIN',             'COMPRESSION',       '圧縮記帳の取消し',             'cumulative', false, 1001),
  ('COMP_TAX',              'COMPRESSION',       '圧縮記帳（税効果）',           'cumulative', true,  1002),
  ('ARO_MAIN',              'ARO',               '資産除去債務の再測定',         'cumulative', false, 1101),
  ('ARO_TAX',               'ARO',               '資産除去債務（税効果）',       'cumulative', true,  1102),
  ('SBP_MAIN',              'SHARE_BASED',       '株式報酬費用',                 'cumulative', false, 1201),
  ('SBP_TAX',               'SHARE_BASED',       '株式報酬（税効果）',           'cumulative', true,  1202),
  ('EIR_MAIN',              'EIR',               '借入手数料の実効金利法',       'cumulative', false, 1301),
  ('EIR_TAX',               'EIR',               '実効金利法（税効果）',         'cumulative', true,  1302),
  ('DEV_MAIN',              'DEVELOPMENT',       '開発費・繰延資産',             'cumulative', false, 1401),
  ('DEV_TAX',               'DEVELOPMENT',       '開発費（税効果）',             'cumulative', true,  1402),
  ('TAX_RECOVERABILITY',    'TAX_EFFECT',        '回収可能性・税率差異',         'cumulative', true,  1501);
