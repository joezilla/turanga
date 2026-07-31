-- control-api owns its own database, separate from LiteLLM's (AD-7).
-- Runs once on a fresh postgres data dir (docker-entrypoint-initdb.d).
CREATE DATABASE control OWNER turanga;
