@extends('layouts.marketing')

@section('title', config('app.name', 'Laravel'))

@section('content')
    <section class="landing-hero" aria-labelledby="landing-heading">
        <div>
            <p class="landing-badge">Automation · IMVU · Bots</p>
            <h1 id="landing-heading" class="landing-h1">
                Your <em>intelligent</em> partner for room &amp; user workflows
            </h1>
            <p class="landing-lead">
                Orchestrate lurk bots, sync targets from the panel, and keep sessions moving — with a control surface
                built for speed and clarity.
            </p>
            <div class="landing-cta-row">
                @auth
                    <a class="landing-btn landing-btn--primary" href="{{ route('dashboard') }}">Open dashboard</a>
                @else
                    @if (Route::has('login'))
                        <a class="landing-btn landing-btn--primary" href="{{ route('login') }}">Login with Discord</a>
                    @endif
                    <a class="landing-btn landing-btn--ghost" href="https://laravel.com/docs" target="_blank" rel="noopener">Docs</a>
                @endauth
                <a class="landing-btn landing-btn--ghost" href="{{ route('contact') }}">Contact</a>
            </div>
        </div>

        <div class="landing-hero-card">
            <h2>Glass dashboard</h2>
            <p>
                The admin panel uses a frosted-glass shell with motion-friendly transitions — tuned for long sessions
                and quick navigation.
            </p>
            <div class="landing-stats">
                <div class="landing-stat">
                    <strong>Live</strong>
                    <span>Panel</span>
                </div>
                <div class="landing-stat">
                    <strong>API</strong>
                    <span>Sync</span>
                </div>
                <div class="landing-stat">
                    <strong>Dark</strong>
                    <span>First</span>
                </div>
            </div>
        </div>
    </section>

    <p class="landing-section-title">Capabilities</p>
    <h2 class="landing-h2">Built for operators, not slide decks</h2>
    <div class="landing-features">
        <article class="landing-feature">
            <h3>Bot orchestration</h3>
            <p>Wire automation to dashboard-defined bots and room targets without juggling ad-hoc scripts.</p>
        </article>
        <article class="landing-feature">
            <h3>Session-aware sync</h3>
            <p>Keep room lists and conversations aligned with what your workers are actually running.</p>
        </article>
        <article class="landing-feature">
            <h3>Glass UI</h3>
            <p>Blur-backed surfaces, soft borders, and hover depth — similar energy to premium AI landing pages.</p>
        </article>
        <article class="landing-feature">
            <h3>Reduced motion</h3>
            <p>Animations respect <code>prefers-reduced-motion</code> in both the site and the Filament theme.</p>
        </article>
    </div>

    <footer class="landing-footer">
        Laravel {{ app()->version() }}
        —
        <a href="https://github.com/laravel/laravel/blob/13.x/CHANGELOG.md" target="_blank" rel="noopener">Changelog</a>
    </footer>
@endsection
