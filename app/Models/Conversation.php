<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Conversation extends Model
{
    protected $fillable = [
        'thread_key',
        'room_id',
        'username',
        'imvu_avatar_id',
        'user_id',
        'server_id',
        'messages',
    ];

    protected $casts = [
        'messages' => 'array',
    ];

    /**
     * Stable thread id: room + avatar id (preferred) or username.
     */
    public static function threadKey(string $roomId, ?string $imvuAvatarId, ?string $username): string
    {
        $participant = $imvuAvatarId
            ? 'id:'.$imvuAvatarId
            : 'name:'.($username ?: 'unknown');

        return hash('sha256', $roomId."\0".$participant);
    }
}
