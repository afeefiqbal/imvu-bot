@extends('layouts.marketing', [
    'viteEntries' => ['resources/css/landing.css', 'resources/css/contact.css'],
])

@section('title', 'Contact Us — '.config('app.name', 'Laravel'))

@section('body_class', 'contact-page')

@section('content')
    <div class="contact-page">
        <header class="contact-hero">
            <nav class="contact-breadcrumb" aria-label="Breadcrumb">
                <a href="{{ route('home') }}">1. Home</a>
                <span class="contact-breadcrumb__sep" aria-hidden="true">/</span>
                <span class="contact-breadcrumb__current">2. Contact Us</span>
            </nav>
            <div class="contact-hero__title-line" aria-hidden="true"></div>
            <h1 class="contact-hero__title">Contact Us</h1>
        </header>

        <section class="contact-info-grid" aria-label="Contact details">
            <article class="contact-info-card">
                <div class="contact-info-card__icon" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                    </svg>
                </div>
                <h3>Address</h3>
                <p>{{ config('contact.address') }}</p>
            </article>
            <article class="contact-info-card">
                <div class="contact-info-card__icon" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
                    </svg>
                </div>
                <h3>Phone Number</h3>
                <p><a href="tel:{{ preg_replace('/\D/', '', config('contact.phone')) }}">{{ config('contact.phone') }}</a></p>
            </article>
            <article class="contact-info-card">
                <div class="contact-info-card__icon" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                    </svg>
                </div>
                <h3>E-mail</h3>
                <p><a href="mailto:{{ config('contact.email') }}">{{ config('contact.email') }}</a></p>
            </article>
        </section>

        <div class="contact-split">
            <div class="contact-form-panel">
                <h2>Send Us Free Message</h2>

                @if (session('contact_sent'))
                    <p class="contact-flash" role="status">Thank you — your message was received.</p>
                @endif

                <form action="{{ route('contact.send') }}" method="post" novalidate>
                    @csrf
                    <div class="contact-field {{ $errors->has('name') ? 'contact-field--error' : '' }}">
                        <label for="contact-name">Name</label>
                        <input id="contact-name" name="name" type="text" value="{{ old('name') }}" required autocomplete="name">
                        @error('name')
                            <p class="contact-field__error">{{ $message }}</p>
                        @enderror
                    </div>
                    <div class="contact-field {{ $errors->has('email') ? 'contact-field--error' : '' }}">
                        <label for="contact-email">E-mail</label>
                        <input id="contact-email" name="email" type="email" value="{{ old('email') }}" required autocomplete="email">
                        @error('email')
                            <p class="contact-field__error">{{ $message }}</p>
                        @enderror
                    </div>
                    <div class="contact-field {{ $errors->has('subject') ? 'contact-field--error' : '' }}">
                        <label for="contact-subject">Subject <span class="contact-label-hint">(optional)</span></label>
                        <input id="contact-subject" name="subject" type="text" value="{{ old('subject') }}" maxlength="200">
                        @error('subject')
                            <p class="contact-field__error">{{ $message }}</p>
                        @enderror
                    </div>
                    <div class="contact-field {{ $errors->has('message') ? 'contact-field--error' : '' }}">
                        <label for="contact-message">Message</label>
                        <textarea id="contact-message" name="message" required>{{ old('message') }}</textarea>
                        @error('message')
                            <p class="contact-field__error">{{ $message }}</p>
                        @enderror
                    </div>
                    <button type="submit" class="contact-submit">send now</button>
                </form>
            </div>

            <aside class="contact-help-card" aria-labelledby="contact-help-heading">
                <div class="contact-help-card__visual" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                    </svg>
                </div>
                <h3 id="contact-help-heading">Need help?</h3>
                <a class="contact-help-card__phone" href="tel:{{ preg_replace('/\D/', '', config('contact.help_phone')) }}">{{ config('contact.help_phone') }}</a>
                <p>Operators available during business hours.</p>
            </aside>
        </div>

        <section class="contact-newsletter" aria-labelledby="newsletter-heading">
            <h3 id="newsletter-heading">Subscribe our Newsletter</h3>
            <div class="contact-newsletter__row">
                <input type="email" name="newsletter_email" placeholder="Your email address" autocomplete="email">
                <button type="button" onclick="this.closest('.contact-newsletter').querySelector('input').value=''">Subscribe</button>
            </div>
            <p class="contact-newsletter__note">Demo-style block — connect to your list when ready.</p>
        </section>

        <footer class="contact-site-footer">
            {{ config('app.name') }} · Laravel {{ app()->version() }}
            —
            <a href="https://github.com/laravel/laravel/blob/13.x/CHANGELOG.md" target="_blank" rel="noopener">Changelog</a>
        </footer>
    </div>
@endsection
