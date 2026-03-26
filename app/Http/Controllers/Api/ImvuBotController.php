<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ImvuBot;
use Illuminate\Http\Request;

class ImvuBotController extends Controller
{
    /**
     * Get bot settings. If bot doesn't exist, create it!
     */
    public function show($name)
    {
        $bot = ImvuBot::firstOrCreate(
            ['name' => $name],
            [
                'username' => 'admin_bot', 
                'password' => 'secret',
                'is_active' => true,
                'ai_enabled' => true,
            ]
        );

        return response()->json($bot);
    }

    /**
     * Update current status (room, last seen, etc.)
     */
    public function updateStatus(Request $request, $name)
    {
        $bot = ImvuBot::firstOrCreate(['name' => $name]);

        $bot->update([
            'current_room_id' => $request->current_room_id,
            'last_seen_at' => now(),
        ]);

        return response()->json(['success' => true]);
    }
}
