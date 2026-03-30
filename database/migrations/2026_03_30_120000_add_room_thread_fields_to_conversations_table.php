<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->string('thread_key', 64)->nullable()->unique()->after('id');
            $table->string('room_id', 64)->nullable()->index()->after('thread_key');
            $table->string('username')->nullable()->after('room_id');
            $table->string('imvu_avatar_id', 48)->nullable()->index()->after('username');
        });
    }

    public function down(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->dropColumn(['thread_key', 'room_id', 'username', 'imvu_avatar_id']);
        });
    }
};
