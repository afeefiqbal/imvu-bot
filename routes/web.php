<?php

use App\Http\Controllers\Auth\DiscordAuthController;
use App\Http\Controllers\ContactController;
use Illuminate\Support\Facades\Route;

Route::view('/', 'welcome')->name('home');

Route::get('/login', [DiscordAuthController::class, 'redirect'])->name('login');
Route::get('/auth/discord/callback', [DiscordAuthController::class, 'callback'])->name('auth.discord.callback');

Route::middleware('auth')->group(function (): void {
    Route::view('/dashboard', 'dashboard')->name('dashboard');
    Route::post('/logout', [DiscordAuthController::class, 'logout'])->name('logout');
});

Route::get('/contact', [ContactController::class, 'show'])->name('contact');
Route::post('/contact', [ContactController::class, 'store'])->name('contact.send');
