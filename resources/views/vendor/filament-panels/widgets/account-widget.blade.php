@php
    $user = filament()->auth()->user();
@endphp

<x-filament-widgets::widget class="fi-account-widget fi-glass-bento-widget">
    <div class="fi-glass-bento-card fi-glass-bento-card--welcome">
        <div class="fi-glass-bento-card__row">
            <x-filament-panels::avatar.user size="lg" :user="$user" />

            <div class="fi-glass-bento-card__copy">
                <h2 class="fi-glass-bento-card__title">
                    {{ __('filament-panels::widgets/account-widget.welcome', ['app' => config('app.name')]) }}
                </h2>

                <p class="fi-glass-bento-card__meta">
                    {{ filament()->getUserName($user) }}
                </p>
            </div>

            <form action="{{ filament()->getLogoutUrl() }}" method="post" class="fi-glass-bento-card__actions">
                @csrf

                <x-filament::button
                    color="gray"
                    icon="heroicon-m-arrow-left-on-rectangle"
                    icon-alias="panels::widgets.account.logout-button"
                    labeled-from="sm"
                    tag="button"
                    type="submit"
                >
                    {{ __('filament-panels::widgets/account-widget.actions.logout.label') }}
                </x-filament::button>
            </form>
        </div>
    </div>
</x-filament-widgets::widget>
