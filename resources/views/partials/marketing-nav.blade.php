<header class="landing-nav">
    <a href="{{ route('home') }}" class="landing-logo">{{ config('app.name', 'Laravel') }}<span>.</span></a>
    <nav class="landing-nav-links" aria-label="Primary">
        <a
            href="{{ route('home') }}"
            class="landing-link {{ request()->routeIs('home') ? 'landing-link--active' : '' }}"
        >Home</a>
        <a
            href="{{ route('contact') }}"
            class="landing-link {{ request()->routeIs('contact') ? 'landing-link--active' : '' }}"
        >Contact</a>
        @if (Route::has('login'))
            @auth
                <a class="landing-link" href="{{ url('/admin') }}">Dashboard</a>
            @else
                <a class="landing-link" href="{{ route('login') }}">Log in</a>
                @if (Route::has('register'))
                    <a class="landing-link" href="{{ route('register') }}">Register</a>
                @endif
            @endauth
        @endif
    </nav>
</header>
