<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class RoomVisitor extends Model
{
    use HasFactory;

    protected $fillable = ['room_id', 'username', 'first_seen_at', 'last_seen_at'];
}
