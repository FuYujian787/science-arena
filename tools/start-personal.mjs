// Personal browser mode uses the same BYOK and per-visitor isolation as hosted mode.
process.env.ARENA_MODE = 'public';
process.env.ARENA_IGNORE_ENV_FILE = '1';
process.env.HOST = '127.0.0.1';
process.env.LLM_PROVIDER = 'deepseek';
await import('../server.mjs');
