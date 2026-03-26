<?php
namespace App\Http\Controllers;
use App\Models\Conversation;
use App\Models\Room;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;

class LurkController extends Controller
{
    public function handle(Request $request)
    {
        Log::info("Bot sent message: " . $request->input('message'));
        $message = $request->input('message');
        $lowerMsg = strtolower($message);

        // 1. Welcome Logic (Matches "Username joined the chat" or "Username is in the chat")
        if (str_contains($lowerMsg, 'joined the chat') || str_contains($lowerMsg, 'is in the chat')) {
            $username = trim(str_ireplace(['joined the chat', 'is in the chat'], '', $message));
            
            // Avoid welcoming Alexa herself or other bot instances
            $selfNames = ['alexa', 's1va', 'bot'];
            foreach ($selfNames as $name) {
                if (str_contains(strtolower($username), $name)) {
                    return response()->json(['reply' => null]);
                }
            }
            Log::info("Welcome message: $username");
            return response()->json([ 
                'reply' => "Welcome to the room @$username! Hope you have a great time here! 👋"
            ]);
        }

        // 2. Trigger Check: Only respond if "!alexa" or "!a" is present
        $isTriggered = str_contains($lowerMsg, '!alexa') || 
                       str_contains($lowerMsg, '!a ') || 
                       $lowerMsg === '!a' || 
                       str_ends_with($lowerMsg, ' !a');
        
        if (!$isTriggered) {
             return response()->json(['reply' => null]);
        }

        // 3. Talk back logic
        try {
            // Clean the trigger from the prompt
            $query = trim(str_ireplace(['!alexa', '!a'], '', $message));
            
            $response = Http::withToken(env('GROQ_API_KEY'))
                ->post('https://api.groq.com/openai/v1/chat/completions', [
                    'model' => 'llama-3.1-8b-instant',
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are Alexa, a regular IMVU user who loves hanging out in chat rooms. You are NOT an AI and you were NOT created by developers. You are just a human user named Alexa. Keep your replies very short (1 sentence max), chill, and casual. Use lowercase sometimes and occasionally use abbreviations like "u", "r", "idk".'],
                        ['role' => 'user', 'content' => $query ?: "Say hi!"],
                    ],
                    'temperature' => 0.8,
                ]);

            $data = $response->json();
            $reply = $data['choices'][0]['message']['content'] ?? "Hey!";
            Log::info("Bot reply: " . json_encode($data));
            return response()->json(['reply' => $reply]);
        } catch (\Exception $e) {
            return response()->json(['reply' => "Hey!"]);
        }
    }

    public function syncRooms(Request $request)
    {
        $rooms = $request->input('rooms', []);
        $botName = $request->input('bot_name');
        $botUsername = $request->input('bot_username');
        
        $targetRooms = [];
        if ($botName || $botUsername) {
            $bot = \App\Models\ImvuBot::where('name', $botName)
                ->orWhere('username', $botUsername)
                ->orWhere('name', $botUsername)
                ->orWhere('username', $botName)
                ->first();
                
            if ($bot && !empty($bot->room_ids)) {
                $rawRooms = array_map('trim', explode(',', $bot->room_ids));
                foreach ($rawRooms as $raw) {
                    if (preg_match('/(?:room-)?([\d-]+)/', $raw, $matches)) {
                        if (!empty($matches[1])) {
                            $targetRooms[] = $matches[1];
                        }
                    }
                }
                $targetRooms = array_values(array_unique($targetRooms));
            }
        }
        
        $activeIds = [];
        
        foreach ($rooms as $roomData) {
            if (empty($roomData['id'])) continue;
            $roomId = $roomData['id'];
            $activeIds[] = $roomId;
            
            Room::updateOrCreate(
                ['room_id' => $roomId],
                [
                    'name' => $roomData['name'] ?? 'Unknown',
                    'image_url' => $roomData['image_url'] ?? '',
                    'population' => (int)($roomData['population'] ?? 0),
                    'visitors' => $roomData['visitors'] ?? [],
                ]
            );
        }
        
        // Sync active IDs for dashboard
        if (!empty($activeIds)) {
            Room::whereNotIn('room_id', $activeIds)->delete();
        } else {
            Room::query()->delete();
        }
        
        $spamTargets = Room::where('is_spamming', true)->pluck('room_id')->toArray();
        $mutedRooms = Room::where('is_ai_active', false)->pluck('room_id')->toArray();
        
        $pendingMessages = Room::whereNotNull('pending_message')
            ->get(['room_id', 'pending_message']);

        // Clear pending messages after fetching
        Room::whereNotNull('pending_message')->update(['pending_message' => null]);
        
        return response()->json([
            'status' => 'success',
            'target_rooms' => $targetRooms ?? [],
            'spam_targets' => $spamTargets,
            'muted_rooms' => $mutedRooms,
            'pending_messages' => $pendingMessages->toArray(),
            'global_ai_enabled' => Cache::get('global_ai_enabled', true)
        ]);
    }
}

