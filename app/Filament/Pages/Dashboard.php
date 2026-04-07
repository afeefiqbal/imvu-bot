<?php

namespace App\Filament\Pages;

use Filament\Pages\Dashboard as BaseDashboard;
use Illuminate\Contracts\Support\Htmlable;

class Dashboard extends BaseDashboard
{
    protected static ?string $navigationLabel = 'Home';

    protected static ?string $title = 'Overview';

    protected ?string $heading = 'Welcome back';

    protected ?string $subheading = 'Your control room — rooms, bots, and conversations in one place.';

    public function getTitle(): string|Htmlable
    {
        return 'Overview';
    }

    /**
     * @return int | string | array<string, int | string | null>
     */
    public function getColumns(): int|string|array
    {
        return 1;
    }
}
