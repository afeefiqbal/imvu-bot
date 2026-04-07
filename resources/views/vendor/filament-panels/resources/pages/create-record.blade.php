<x-filament-panels::page
    @class([
        'fi-resource-create-record-page',
        'fi-resource-' . str_replace('/', '-', $this->getResource()::getSlug()),
    ])
>
    <div class="fi-glass-workspace-shell">
        <div class="fi-glass-workspace-shell__grid">
            @include('filament-panels::partials.workspace-glass-aside')

            <div class="fi-glass-workspace-shell__form-col">
                @include('filament-panels::partials.glass-form-intro', [
                    'heading' => $this->getHeading(),
                    'subheading' => $this->getSubheading(),
                ])

                <x-filament-panels::form
                    id="form"
                    :wire:key="$this->getId() . '.forms.' . $this->getFormStatePath()"
                    wire:submit="create"
                >
                    {{ $this->form }}

                    <x-filament-panels::form.actions
                        :actions="$this->getCachedFormActions()"
                        :full-width="$this->hasFullWidthFormActions()"
                    />
                </x-filament-panels::form>
            </div>
        </div>
    </div>

    <x-filament-panels::page.unsaved-data-changes-alert />
</x-filament-panels::page>
