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
                <a class="landing-link" href="{{ route('dashboard') }}">Dashboard</a>
                <form action="{{ route('logout') }}" method="POST">
                    @csrf
                    <button class="landing-link" type="submit">Log out</button>
                </form>
            @else
                <a class="landing-link" href="{{ route('login') }}">Login with Discord</a>
            @endauth
        @endif
    </nav>
</header>
