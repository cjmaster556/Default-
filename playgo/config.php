<?php
// Settings come from environment variables (see .env.example).
function playgo_env($key, $default = '') {
    $v = getenv($key);
    return ($v === false || $v === '') ? $default : $v;
}

define('IP', rtrim(playgo_env('XTREAM_URL', 'http://example.com:8080'), '/')); // Xtream server, with scheme + port
define('TMDB_API_KEY', playgo_env('TMDB_API_KEY'));
define('LANGUAGE', playgo_env('LANGUAGE', 'en-US'));
define('NOME_IPTV', playgo_env('APP_NAME', 'PLAYGO'));

$customChannelLogos = [];

define('SMTP_HOST', playgo_env('SMTP_HOST'));
define('SMTP_USER', playgo_env('SMTP_USER'));
define('SMTP_SENHA', playgo_env('SMTP_PASSWORD'));
define('SMTP_SEGURANCA', playgo_env('SMTP_SECURITY', 'tls'));
define('EMAIL_ASSUNTO', 'Welcome to ' . NOME_IPTV);
define('EMAIL_REVENDA', playgo_env('SMTP_FROM'));
define('NOME_REVENDA', NOME_IPTV);

define('SAGAS_ADMIN_ENABLED', filter_var(playgo_env('SAGAS_ADMIN_ENABLED', 'false'), FILTER_VALIDATE_BOOLEAN));
define('SAGAS_ADMIN_USER', playgo_env('SAGAS_ADMIN_USER', 'admin'));

define('CORPO_EMAIL', 'Hi %NOME%, your account is ready.<br><br>User: <b>%USUARIO%</b><br>Password: <b>%SENHA%</b><br><br>Valid until: %VENCIMENTO%');
