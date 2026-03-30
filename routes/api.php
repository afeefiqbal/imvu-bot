<?php

use App\Http\Controllers\Api\ImvuBotController;
use App\Http\Controllers\LurkController;
use App\Http\Controllers\SivaCharacterAiController;
use Illuminate\Support\Facades\Route;

Route::post('/lurk', [LurkController::class, 'handle']);
Route::post('/siva-chat', [SivaCharacterAiController::class, 'handle']);
Route::post('/conversations/append', [LurkController::class, 'appendConversation']);
Route::post('/rooms/sync', [LurkController::class, 'syncRooms']);

Route::get('/bots/{name}', [ImvuBotController::class, 'show']);
Route::post('/bots/{name}/status', [ImvuBotController::class, 'updateStatus']);
Route::post('/room-users', [LurkController::class, 'trackRoomUser']);
