<?php

use App\Http\Controllers\LurkController;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\ImvuBotController;

Route::post('/lurk', [LurkController::class, 'handle']);
Route::post('/clear', [LurkController::class, 'clear']);
Route::post('/rooms/sync', [LurkController::class, 'syncRooms']);

Route::get('/bots/{name}', [ImvuBotController::class, 'show']);
Route::post('/bots/{name}/status', [ImvuBotController::class, 'updateStatus']);