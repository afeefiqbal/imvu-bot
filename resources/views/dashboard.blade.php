@extends('layouts.marketing')

@section('title', 'Dashboard · '.config('app.name', 'Laravel'))

@section('content')
    @php
        $user = auth()->user();
        $superAdminEmails = collect(config('auth.super_admin_emails', []))
            ->map(fn (string $email): string => strtolower($email));
        $canAccessAdmin = $user && $superAdminEmails->contains(strtolower((string) $user->email));
    @endphp

    <section class="landing-hero" aria-labelledby="dashboard-heading">
        <div>
            <p class="landing-badge">Discord account connected</p>
            <h1 id="dashboard-heading" class="landing-h1">
                Welcome, <em>{{ $user->name }}</em>
            </h1>
            <p class="landing-lead">
                Your user session is authenticated through Discord. Admin tools remain behind the separate
                super-admin login at <code>/admin/login</code>.
            </p>

            <div class="landing-cta-row">
                @if ($canAccessAdmin)
                    <a class="landing-btn landing-btn--primary" href="{{ url('/admin') }}">Open admin panel</a>
                @endif

                <form action="{{ route('logout') }}" method="POST">
                    @csrf
                    <button class="landing-btn landing-btn--ghost" type="submit">Log out</button>
                </form>
            </div>
        </div>

        <div class="landing-hero-card">
            <h2>User account</h2>
            <p>{{ $user->email }}</p>
            <div class="landing-stats">
                <div class="landing-stat">
                    <strong>Discord</strong>
                    <span>Login</span>
                </div>
                <div class="landing-stat">
                    <strong>Admin</strong>
                    <span>{{ $canAccessAdmin ? 'Allowed' : 'Locked' }}</span>
                </div>
            </div>
        </div>
    </section>
@endsection
