<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>@yield('arcop-titulo', config('arcop-panel.titulo'))</title>
    {{-- El CSS se publica a public/vendor/arcop-panel: el paquete no depende de
         ningún bundler del adoptante. --}}
    <link rel="stylesheet" href="{{ asset('vendor/arcop-panel/arcop-panel.css') }}">
</head>
<body class="arcop-cuerpo">
    <a class="arcop-saltar" href="#arcop-contenido">Saltar al contenido</a>
    <header class="arcop-cabecera">
        <p class="arcop-cabecera__sistema">{{ config('arcop-panel.titulo') }}</p>
        <nav aria-label="Panel de solicitudes">
            <a href="{{ route('arcop.solicitudes.index') }}">Bandeja</a>
        </nav>
    </header>
    <main id="arcop-contenido" class="arcop-contenido">
        @yield('arcop')
    </main>
</body>
</html>
