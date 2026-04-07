<x-filament-panels::page
    @class([
        'fi-resource-edit-record-page',
        'fi-resource-' . str_replace('/', '-', $this->getResource()::getSlug()),
        'fi-resource-record-' . $record->getKey(),
    ])
>
    @capture($form)
        <x-filament-panels::form
            id="form"
            :wire:key="$this->getId() . '.forms.' . $this->getFormStatePath()"
            wire:submit="save"
        >
            {{ $this->form }}

            <x-filament-panels::form.actions
                :actions="$this->getCachedFormActions()"
                :full-width="$this->hasFullWidthFormActions()"
            />
        </x-filament-panels::form>
    @endcapture

    @php
        $relationManagers = $this->getRelationManagers();
        $hasCombinedRelationManagerTabsWithContent = $this->hasCombinedRelationManagerTabsWithContent();
    @endphp

    @if ((! $hasCombinedRelationManagerTabsWithContent) || (! count($relationManagers)))
        <div class="fi-glass-workspace-shell">
            <div class="fi-glass-workspace-shell__grid">
                @include('filament-panels::partials.workspace-glass-aside')

                <div class="fi-glass-workspace-shell__form-col">
                    @include('filament-panels::partials.glass-form-intro', [
                        'heading' => $this->getHeading(),
                        'subheading' => $this->getSubheading(),
                    ])

                    {{ $form() }}
                </div>
            </div>
        </div>
    @endif

    @if (count($relationManagers))
        <x-filament-panels::resources.relation-managers
            :active-locale="isset($activeLocale) ? $activeLocale : null"
            :active-manager="$this->activeRelationManager ?? ($hasCombinedRelationManagerTabsWithContent ? null : array_key_first($relationManagers))"
            :content-tab-label="$this->getContentTabLabel()"
            :content-tab-icon="$this->getContentTabIcon()"
            :content-tab-position="$this->getContentTabPosition()"
            :managers="$relationManagers"
            :owner-record="$record"
            :page-class="static::class"
        >
            @if ($hasCombinedRelationManagerTabsWithContent)
                <x-slot name="content">
                    <div class="fi-glass-workspace-shell">
                        <div class="fi-glass-workspace-shell__grid">
                            @include('filament-panels::partials.workspace-glass-aside')

                            <div class="fi-glass-workspace-shell__form-col">
                                @include('filament-panels::partials.glass-form-intro', [
                                    'heading' => $this->getHeading(),
                                    'subheading' => $this->getSubheading(),
                                ])

                                {{ $form() }}
                            </div>
                        </div>
                    </div>
                </x-slot>
            @endif
        </x-filament-panels::resources.relation-managers>
    @endif

    <x-filament-panels::page.unsaved-data-changes-alert />
</x-filament-panels::page>
