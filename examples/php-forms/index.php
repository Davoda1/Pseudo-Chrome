<?php
declare(strict_types=1);
session_start();
$_SESSION['visits'] = ($_SESSION['visits'] ?? 0) + 1;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $_SESSION['name'] = mb_substr(trim((string)($_POST['name'] ?? '')), 0, 80);
    header('Location: /', true, 303);
    exit;
}
$name = htmlspecialchars((string)($_SESSION['name'] ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$visits = (int)$_SESSION['visits'];
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PHP website example</title>
<style>:root{color-scheme:light dark;font:16px/1.7 system-ui,sans-serif}body{max-width:760px;margin:50px auto;padding:0 24px}h1{font-size:34px}form,.session{padding:24px;border:1px solid #80909f66;border-radius:12px;margin:24px 0}label{display:block;margin-bottom:8px}input,button{font:inherit;padding:9px 12px;border:1px solid #80909f88;border-radius:7px}input{max-width:100%;margin-right:8px}button{cursor:pointer}small{opacity:.7}.value{font-size:25px;font-weight:600}</style></head>
<body><h1>A PHP form with a session.</h1><p>Submit a display name. Reloading keeps it in the same PHP session.</p>
<form method="post" action="/"><label for="name">Display name</label><input id="name" name="name" value="<?= $name ?>" maxlength="80" autocomplete="off"><button type="submit">Save in session</button></form>
<section class="session"><div class="value"><?= $name !== '' ? 'Hello, ' . $name . '.' : 'No name saved yet.' ?></div><p>Requests in this session: <strong><?= $visits ?></strong></p><small>PHP <?= htmlspecialchars(PHP_VERSION, ENT_QUOTES, 'UTF-8') ?> · no database required</small></section>
<p>The form uses a real POST request, a redirect and a session cookie. The server escapes the displayed name.</p></body></html>
