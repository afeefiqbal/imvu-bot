@php
    $heading = $heading ?? null;
    $subheading = $subheading ?? null;
@endphp

<div class="fi-glass-workspace-shell__form-head">
    @if (filled($heading))
        <h2 class="fi-glass-workspace-shell__title">{{ $heading }}</h2>
    @endif
    @if (filled($subheading))
        <p class="fi-glass-workspace-shell__lead">{{ $subheading }}</p>
    @endif
</div>
