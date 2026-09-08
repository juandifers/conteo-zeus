-- A row nobody counted posts as zero, not as the book figure.
--
-- Policy decision (2026-09): a blank articulo must zero out the entry in the
-- exported file. The default flips to 'zero', and every session that has not
-- been sealed yet moves with it — an open count exported tomorrow has to say
-- what the rule says today. Sealed and closed sessions keep the policy they
-- were sealed under: their bytes are frozen (0005), and rewriting the setting
-- under a seal would make `export_bytes` a file the session's own parameters
-- disclaim.
--
-- `VERIFIED_PARAMETERS` in src/app/parameters.ts changes in the same commit;
-- dispatch refuses any session whose triple disagrees with it, so a draft
-- created on 'existencia' before this migration would otherwise become
-- un-dispatchable rather than silently posting book figures.

alter table sessions alter column uncounted_policy set default 'zero';

update sessions
   set uncounted_policy = 'zero'
 where sealed_at is null
   and uncounted_policy = 'existencia';
