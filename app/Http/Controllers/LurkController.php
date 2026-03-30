<?php

namespace App\Http\Controllers;

use App\Models\Conversation;
use App\Models\ImvuBot;
use App\Models\Room;
use App\Models\RoomVisitor;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class LurkController extends Controller
{
    /**
     * Append one message to a room conversation thread (IMVU user ↔ bot).
     */
    protected function appendConversationTurn(
        ?string $roomId,
        ?string $username,
        ?string $imvuAvatarId,
        string $role,
        string $content,
    ): void {
        if (! $roomId || $content === '') {
            return;
        }

        $uname = $username ?: 'unknown';
        $threadKey = Conversation::threadKey($roomId, $imvuAvatarId, $uname);
        $conv = Conversation::firstOrNew(
            ['thread_key' => $threadKey],
            [
                'room_id' => $roomId,
                'username' => $username,
                'imvu_avatar_id' => $imvuAvatarId,
                'user_id' => ($imvuAvatarId !== null && $imvuAvatarId !== '' && ctype_digit((string) $imvuAvatarId))
                    ? (int) $imvuAvatarId
                    : 0,
                'server_id' => 0,
                'messages' => [],
            ]
        );

        $messages = is_array($conv->messages) ? $conv->messages : [];
        $messages[] = [
            'role' => $role,
            'content' => $content,
            'at' => now()->toIso8601String(),
        ];
        $conv->messages = $messages;
        $conv->room_id = $roomId;
        if ($username) {
            $conv->username = $username;
        }
        if ($imvuAvatarId) {
            $conv->imvu_avatar_id = $imvuAvatarId;
        }
        $conv->save();
    }

    public function appendConversation(Request $request)
    {
        $validated = $request->validate([
            'room_id' => 'required|string',
            'username' => 'nullable|string',
            'imvu_avatar_id' => 'nullable|string',
            'role' => 'required|in:user,assistant,system',
            'content' => 'required|string',
        ]);

        $this->appendConversationTurn(
            $validated['room_id'],
            $validated['username'] ?? null,
            $validated['imvu_avatar_id'] ?? null,
            $validated['role'],
            $validated['content'],
        );

        return response()->json(['status' => 'success']);
    }

    public function handle(Request $request)
    {
        Log::info('Bot sent message: '.$request->input('message'));
        $message = (string) $request->input('message');
        $roomId = $request->input('room_id') ? (string) $request->input('room_id') : null;
        $contextUser = $request->input('username') ? (string) $request->input('username') : null;
        $imvuAvatarId = $request->input('imvu_avatar_id') ? (string) $request->input('imvu_avatar_id') : null;
        $botUsername = $request->input('bot_username') ? trim((string) $request->input('bot_username')) : null;
        $botDisplayName = $request->input('bot_display_name') ? trim((string) $request->input('bot_display_name')) : null;
        $skipUserTurnAppend = $request->boolean('already_logged_user_message');

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
            $reply = "Welcome to the room @$username! Hope you have a great time here! 👋";
            if ($roomId) {
                $this->appendConversationTurn($roomId, $username, $imvuAvatarId, 'assistant', $reply);
            }

            return response()->json([
                'reply' => $reply,
            ]);
        }

        // 2. Trigger: !commands or addressing the bot by username / display name
        $isCommandTriggered = str_contains($lowerMsg, '!alexa') ||
                       str_contains($lowerMsg, '!a ') ||
                       $lowerMsg === '!a' ||
                       str_ends_with($lowerMsg, ' !a');
        $mentionsBot = $this->messageAddressesBot($message, $botUsername, $botDisplayName);
        $isTriggered = $isCommandTriggered || $mentionsBot;

        if (! $isTriggered) {
            return response()->json(['reply' => null]);
        }

        // 3. Talk back logic
        try {
            // Clean command triggers from the prompt (name mentions stay for context)
            $query = trim(str_ireplace(['!alexa', '!a'], '', $message));

            $response = Http::withToken(env('GROQ_API_KEY'))
                ->post('https://api.groq.com/openai/v1/chat/completions', [
                    'model' => 'llama-3.1-8b-instant',
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are Alexa, a regular IMVU user who loves hanging out in chat rooms. You are NOT an AI and you were NOT created by developers. You are just a human user named Alexa. Keep your replies very short (1 sentence max), chill, and casual. Use lowercase sometimes and occasionally use abbreviations like "u", "r", "idk".'],
                        ['role' => 'user', 'content' => $query ?: 'Say hi!'],
                    ],
                    'temperature' => 0.8,
                ]);

            $data = $response->json();
            $reply = $data['choices'][0]['message']['content'] ?? 'Hey!';
            Log::info('Bot reply: '.json_encode($data));

            if ($roomId && $contextUser) {
                if (! $skipUserTurnAppend) {
                    $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'user', $message);
                }
                $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'assistant', $reply);
            }

            return response()->json(['reply' => $reply]);
        } catch (\Exception $e) {
            $reply = 'Hey!';
            if ($roomId && $contextUser) {
                if (! $skipUserTurnAppend) {
                    $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'user', $message);
                }
                $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'assistant', $reply);
            }

            return response()->json(['reply' => $reply]);
        }
    }

    /**
     * True if the message @-mentions or uses the bot's username / display name as a phrase or whole word.
     */
    protected function messageAddressesBot(string $message, ?string $botUsername, ?string $botDisplayName): bool
    {
        $aliases = array_values(array_unique(array_filter(
            array_map('trim', array_filter([$botUsername, $botDisplayName])),
            fn ($a) => $a !== ''
        )));

        if ($aliases === []) {
            return false;
        }

        $lower = strtolower($message);

        foreach ($aliases as $alias) {
            $aLower = strtolower($alias);
            if ($aLower === '') {
                continue;
            }
            if (str_contains($lower, '@'.$aLower)) {
                return true;
            }
            if (str_contains($aLower, ' ')) {
                if (str_contains($lower, $aLower)) {
                    return true;
                }

                continue;
            }
            if (preg_match('/\b'.preg_quote($aLower, '/').'\b/u', $lower)) {
                return true;
            }
        }

        return false;
    }

    public function syncRooms(Request $request)
    {
        $rooms = $request->input('rooms', []);
        $botName = $request->input('bot_name');
        $botUsername = $request->input('bot_username');

        $targetRooms = [];

        if ($botName || $botUsername) {
            $bot = ImvuBot::where('name', $botName)
                ->orWhere('username', $botUsername)
                ->first();

            if (! $bot && $botName && $botUsername) {
                // Auto-register missing bot to Dashboard
                $bot = ImvuBot::forceCreate([
                    'name' => $botName,
                    'username' => $botUsername,
                    'password' => 'Unset',
                    'last_seen_at' => now(),
                    'is_active' => true,
                ]);
            } elseif ($bot) {
                $bot->update(['last_seen_at' => now(), 'is_active' => true]);
            }

            if ($bot && ! empty($bot->room_ids)) {
                $rawRooms = array_map('trim', explode(',', $bot->room_ids));
                foreach ($rawRooms as $raw) {
                    if (preg_match('/(?:room-)?([\d-]+)/', $raw, $matches)) {
                        if (! empty($matches[1])) {
                            $targetRooms[] = $matches[1];
                        }
                    }
                }
                $targetRooms = array_values(array_unique($targetRooms));
            }
        }

        $activeIds = [];

        foreach ($rooms as $roomData) {
            if (empty($roomData['id'])) {
                continue;
            }
            $roomId = (string) $roomData['id'];
            $activeIds[] = $roomId;

            Room::updateOrCreate(
                ['room_id' => $roomId],
                [
                    'name' => $roomData['name'] ?? 'Unknown',
                    'image_url' => $roomData['image_url'] ?? '',
                    'population' => (int) ($roomData['population'] ?? 0),
                    'visitors' => $roomData['visitors'] ?? [],
                ]
            );

            if (! empty($roomData['visitors']) && is_array($roomData['visitors'])) {
                foreach ($roomData['visitors'] as $visitor) {
                    // Skip empty, whitespace-only, or invisible-character usernames
                    $cleanVisitor = trim($visitor);
                    if (empty($cleanVisitor) || ! preg_match('/\S/u', $cleanVisitor)) {
                        continue;
                    }
                    $record = RoomVisitor::firstOrNew([
                        'room_id' => (string) $roomId,
                        'username' => $cleanVisitor,
                    ]);
                    if (! $record->exists) {
                        $record->first_seen_at = now();
                    }
                    $record->last_seen_at = now();
                    $record->save();
                }
            }

        }

        // Sync active IDs for dashboard - ONLY if the bot reported ANY rooms
        // This prevents wiping the dashboard during startup syncs (which are empty)
        if (! empty($activeIds)) {
            Room::whereNotIn('room_id', $activeIds)->delete();
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
            'global_ai_enabled' => Cache::get('global_ai_enabled', true),
        ]);
    }

    public function trackRoomUser(Request $request)
    {
        $request->validate([
            'username' => 'required|string',
            'room_id' => 'required|string',
            'event' => 'required|in:join,leave',
        ]);

        $username = $request->input('username');
        $roomId = $request->input('room_id');
        $event = $request->input('event');

        Log::info("[TRACKER] $username ($event) in room $roomId");

        $visitor = RoomVisitor::firstOrNew([
            'room_id' => (string) $roomId,
            'username' => $username,
        ]);

        if (! $visitor->exists) {
            $visitor->first_seen_at = now();
        }
        $visitor->last_seen_at = now();
        $visitor->save();

        return response()->json(['status' => 'success']);
    }
}
