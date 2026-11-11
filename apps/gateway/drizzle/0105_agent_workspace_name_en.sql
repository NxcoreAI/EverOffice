-- 项目空间英文展示名：英文界面优先用它，留空则回落到 name。
-- ADD 写法可被 runAdditiveMigrationIdempotently 的 ALTER 守卫安全重放。
ALTER TABLE `agent_workspaces` ADD `name_en` text;
