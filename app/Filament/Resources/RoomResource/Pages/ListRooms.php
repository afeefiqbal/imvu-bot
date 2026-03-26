<?php

namespace App\Filament\Resources\RoomResource\Pages;

use App\Filament\Resources\RoomResource;
use Filament\Actions;
use Filament\Resources\Pages\ListRecords;

use Illuminate\Support\Facades\Cache;

class ListRooms extends ListRecords
{
    protected static string $resource = RoomResource::class;

    protected function getHeaderActions(): array
    {
        $isAiEnabled = Cache::get('global_ai_enabled', true);

        return [
            Actions\Action::make('toggle_ai')
                ->label($isAiEnabled ? 'Stop AI Globally' : 'Start AI Globally')
                ->color($isAiEnabled ? 'danger' : 'success')
                ->icon($isAiEnabled ? 'heroicon-o-stop' : 'heroicon-o-play')
                ->requiresConfirmation()
                ->action(function () use ($isAiEnabled) {
                    Cache::put('global_ai_enabled', !$isAiEnabled);
                    redirect(request()->header('Referer'));
                }),
            Actions\CreateAction::make(),
        ];
    }
}
