<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>@yield('title', config('app.name', 'Laravel'))</title>
        @if (file_exists(public_path('build/manifest.json')) || file_exists(public_path('hot')))
            @vite($viteEntries ?? ['resources/css/landing.css'])
        @else
            <style>
                body {
                    margin: 0;
                    min-height: 100vh;
                    background: #030306;
                    color: #f4f4f5;
                    font-family: system-ui, sans-serif;
                    padding: 2rem;
                }
                a {
                    color: #e50914;
                }
            </style>
        @endif
        @stack('styles')
    </head>
    <body class="landing-page @yield('body_class')">
        <div class="landing-page__noise" aria-hidden="true"></div>
        <div class="landing-page__mesh" aria-hidden="true"></div>
        <div class="landing-orb landing-orb--1" aria-hidden="true"></div>
        <div class="landing-orb landing-orb--2" aria-hidden="true"></div>
        <div class="landing-orb landing-orb--3" aria-hidden="true"></div>

        <div class="landing-wrap">
            @include('partials.marketing-nav')

            @yield('content')
        </div>
        @stack('scripts')
    </body>
</html>
