<?php

namespace App\Filament\Resources\ImvuBotResource\Pages;

use App\Filament\Resources\ImvuBotResource;
use Filament\Actions;
use Filament\Resources\Pages\ListRecords;

class ListImvuBots extends ListRecords
{
    protected static string $resource = ImvuBotResource::class;

    protected function getHeaderActions(): array
    {
        return [
            Actions\CreateAction::make(),
        ];
    }
}
