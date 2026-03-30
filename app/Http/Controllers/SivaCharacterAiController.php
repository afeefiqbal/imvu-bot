<?php

namespace App\Http\Controllers;

use App\Models\Conversation;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class SivaCharacterAiController extends Controller
{
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

    /**
     * Proxy to your Character.AI HTTP endpoint (or OpenAI-compatible bridge).
     *
     * Configure:
     * - CHARACTER_AI_API_URL — POST URL
     * - CHARACTER_AI_API_KEY — optional; sent as Bearer unless CHARACTER_AI_AUTH_HEADER is set
     * - CHARACTER_AI_AUTH_HEADER — e.g. "Token" to send "Token {key}" instead of Bearer
     * - CHARACTER_AI_CHARACTER_ID — optional; merged into JSON body as character_external_id
     */
    public function handle(Request $request)
    {
        $validated = $request->validate([
            'message' => 'required|string',
            'room_id' => 'nullable|string',
            'username' => 'nullable|string',
            'imvu_avatar_id' => 'nullable|string',
            'already_logged_user_message' => 'sometimes|boolean',
        ]);

        $message = trim((string) $validated['message']);
        $roomId = isset($validated['room_id']) ? (string) $validated['room_id'] : null;
        $contextUser = isset($validated['username']) ? (string) $validated['username'] : null;
        $imvuAvatarId = isset($validated['imvu_avatar_id']) ? (string) $validated['imvu_avatar_id'] : null;
        $skipUserTurnAppend = $request->boolean('already_logged_user_message');

        $url = env('CHARACTER_AI_API_URL');
        $apiKey = env('CHARACTER_AI_API_KEY');

        if (! $url || ! $apiKey) {
            Log::notice('Siva Character.AI: set CHARACTER_AI_API_URL and CHARACTER_AI_API_KEY');

            return response()->json(['reply' => null]);
        }

        $charId = env('CHARACTER_AI_CHARACTER_ID');
        $text = $message !== '' ? $message : 'Say hi!';
        $payload = ['text' => $text];
        if ($charId) {
            $payload['character_external_id'] = $charId;
            $payload['character_id'] = $charId;
        }

        try {
            $authHeader = env('CHARACTER_AI_AUTH_HEADER', 'Bearer');
            $headers = ['Content-Type' => 'application/json', 'Accept' => 'application/json'];
            if (strcasecmp($authHeader, 'Bearer') === 0) {
                $http = Http::withToken($apiKey)->withHeaders($headers);
            } else {
                $headers['Authorization'] = $authHeader.' '.$apiKey;
                $http = Http::withHeaders($headers);
            }

            $response = $http->post($url, $payload);
            $data = $response->json();

            $reply = $this->extractReplyFromResponse(is_array($data) ? $data : null);

            if ($reply === null || $reply === '') {
                Log::warning('Siva Character.AI: empty reply', ['status' => $response->status()]);

                return response()->json(['reply' => null]);
            }

            if ($roomId && $contextUser) {
                if (! $skipUserTurnAppend) {
                    $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'user', $request->input('raw_message') ? (string) $request->input('raw_message') : $message);
                }
                $this->appendConversationTurn($roomId, $contextUser, $imvuAvatarId, 'assistant', $reply);
            }

            return response()->json(['reply' => $reply]);
        } catch (\Throwable $e) {
            Log::error('Siva Character.AI: '.$e->getMessage());

            return response()->json(['reply' => null]);
        }
    }

    protected function extractReplyFromResponse(?array $data): ?string
    {
        if ($data === null) {
            return null;
        }

        $paths = [
            ['reply'],
            ['text'],
            ['message'],
            ['response'],
            ['choices', 0, 'message', 'content'],
            ['data', 'text'],
            ['replies', 0, 'text'],
        ];

        foreach ($paths as $path) {
            $v = $data;
            foreach ($path as $key) {
                if (! is_array($v) || ! array_key_exists($key, $v)) {
                    $v = null;
                    break;
                }
                $v = $v[$key];
            }
            if (is_string($v) && trim($v) !== '') {
                return trim($v);
            }
        }

        return null;
    }
}
