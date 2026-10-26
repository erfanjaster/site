<?php
// Guard: if the web server ignores .htaccess (e.g. nginx without the
// documented snippet), a request for /storage/ still hits this file.
http_response_code(403);
header('Content-Type: text/plain; charset=utf-8');
exit('403 Forbidden');
