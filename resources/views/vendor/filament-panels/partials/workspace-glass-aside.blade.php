{{-- Glass info column (contact-page style — not admin chrome) --}}
<aside class="fi-glass-aside" aria-label="{{ __('Workspace') }}">
    <div class="fi-glass-aside__intro">
        <p class="fi-glass-aside__eyebrow">{{ config('app.name') }}</p>
        <h3 class="fi-glass-aside__heading">{{ __('Workspace') }}</h3>
        <p class="fi-glass-aside__text">
            {{ __('Bots, rooms, and chats — keep context visible while you edit.') }}
        </p>
    </div>

    @php
        $cards = [
            [
                'icon' => 'heroicon-o-map-pin',
                'label' => __('Focus'),
                'body' => __('Fields autosave context for IMVU rooms and channels.'),
            ],
            [
                'icon' => 'heroicon-o-bolt',
                'label' => __('Realtime'),
                'body' => __('Changes apply on save; toggles control live bot behavior.'),
            ],
            [
                'icon' => 'heroicon-o-shield-check',
                'label' => __('Session'),
                'body' => __('You’re signed in securely — sign out from the menu when done.'),
            ],
        ];
    @endphp

    <ul class="fi-glass-aside__cards">
        @foreach ($cards as $card)
            <li class="fi-glass-aside__card">
                <div class="fi-glass-aside__icon-wrap" aria-hidden="true">
                    <x-filament::icon :icon="$card['icon']" class="fi-glass-aside__icon" />
                </div>
                <div class="fi-glass-aside__card-body">
                    <p class="fi-glass-aside__card-title">{{ $card['label'] }}</p>
                    <p class="fi-glass-aside__card-text">{{ $card['body'] }}</p>
                </div>
            </li>
        @endforeach
    </ul>
</aside>
