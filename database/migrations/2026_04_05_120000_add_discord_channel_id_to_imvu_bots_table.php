<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('imvu_bots', function (Blueprint $table) {
            $table->string('discord_channel_id')->nullable()->after('proxy');
        });
    }

    public function down(): void
    {
        Schema::table('imvu_bots', function (Blueprint $table) {
            $table->dropColumn('discord_channel_id');
        });
    }
};
