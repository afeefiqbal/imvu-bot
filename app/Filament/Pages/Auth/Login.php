<?php

namespace App\Filament\Pages\Auth;

use Filament\Pages\Auth\Login as BaseLogin;
use Illuminate\Contracts\Support\Htmlable;

class Login extends BaseLogin
{
    protected ?string $maxWidth = 'md';

    public function getHeading(): string|Htmlable
    {
        return __('Sign in');
    }
}
