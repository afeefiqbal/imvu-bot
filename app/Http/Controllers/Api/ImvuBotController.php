<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ImvuBot;
use Illuminate\Http\Request;

class ImvuBotController extends Controller
{
    /**
     * Get all active bots.
     */
    public function index()
    {
        return response()->json(ImvuBot::where('is_active', true)->get());
    }

    /**
     * Get bot settings (automation must use an existing dashboard bot row).
     */
    public function show($name)
    {
        $bot = ImvuBot::where('name', $name)->first();
        if (! $bot) {
            return response()->json(['message' => 'Bot not found'], 404);
        }

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
