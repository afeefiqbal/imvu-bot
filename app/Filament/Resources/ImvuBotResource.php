<?php

namespace App\Filament\Resources;

use App\Filament\Resources\ImvuBotResource\Pages;
use App\Filament\Resources\ImvuBotResource\RelationManagers;
use App\Models\ImvuBot;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;
use Filament\Notifications\Notification;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\SoftDeletingScope;

class ImvuBotResource extends Resource
{
    protected static ?string $model = ImvuBot::class;

    protected static ?string $navigationIcon = 'heroicon-o-rectangle-stack';

    public static function form(Form $form): Form
    {
        return $form
            ->schema([
                Forms\Components\TextInput::make('name')
                    ->required()
                    ->maxLength(255),
                Forms\Components\TextInput::make('username')
                    ->required()
                    ->maxLength(255),
                Forms\Components\TextInput::make('password')
                    ->password()
                    ->required()
                    ->maxLength(255),
                Forms\Components\TagsInput::make('room_ids')
                    ->label('Target Rooms')
                    ->placeholder('Add Room ID and press enter')
                    ->separator(',')
                    ->columnSpanFull(),
                Forms\Components\Toggle::make('is_active')
                    ->required(),
                Forms\Components\TextInput::make('current_room_id')
                    ->maxLength(255),
                Forms\Components\Toggle::make('ai_enabled')
                    ->required(),
                Forms\Components\Toggle::make('spam_enabled')
                    ->required(),
                Forms\Components\DateTimePicker::make('last_seen_at'),
            ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('name')
                    ->searchable(),
                Tables\Columns\TextColumn::make('username')
                    ->searchable(),
                Tables\Columns\TextColumn::make('room_ids')
                    ->label('Target Rooms')
                    ->searchable()
                    ->limit(30),
                Tables\Columns\IconColumn::make('is_active')
                    ->boolean(),
                Tables\Columns\TextColumn::make('current_room_id')
                    ->searchable(),
                Tables\Columns\IconColumn::make('ai_enabled')
                    ->boolean(),
                Tables\Columns\IconColumn::make('spam_enabled')
                    ->boolean(),
                Tables\Columns\TextColumn::make('last_seen_at')
                    ->dateTime()
                    ->sortable(),
                Tables\Columns\TextColumn::make('created_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
                Tables\Columns\TextColumn::make('updated_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                //
            ])
            ->actions([
                Tables\Actions\Action::make('join_room')
                    ->label('Join Room')
                    ->icon('heroicon-o-chat-bubble-left-right')
                    ->color('success')
                    ->form([
                        Forms\Components\TextInput::make('room_id')
                            ->label('Room URL or ID')
                            ->required()
                            ->placeholder('e.g. 123456 or https://...'),
                    ])
                    ->action(function (ImvuBot $record, array $data) {
                        // Extract numeric ID if URL
                        $roomId = $data['room_id'];
                        if (preg_match('/(?:room-)?([\d-]+)/', $roomId, $matches)) {
                            $roomId = $matches[1];
                        }

                        $existing = trim($record->room_ids ?? '');
                        if ($existing) {
                            $rooms = array_map('trim', explode(',', $existing));
                            if (!in_array($roomId, $rooms)) {
                                $record->update(['room_ids' => $existing . ',' . $roomId]);
                            }
                        } else {
                            $record->update(['room_ids' => $roomId]);
                        }
                        Notification::make()
                            ->title('Command Sent!')
                            ->body("Bot {$record->name} will join room $roomId shortly.")
                            ->success()
                            ->send();
                    }),
                Tables\Actions\EditAction::make(),
            ])
            ->bulkActions([
                Tables\Actions\BulkActionGroup::make([
                    Tables\Actions\DeleteBulkAction::make(),
                ]),
            ]);
    }

    public static function getRelations(): array
    {
        return [
            //
        ];
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListImvuBots::route('/'),
            'create' => Pages\CreateImvuBot::route('/create'),
            'edit' => Pages\EditImvuBot::route('/{record}/edit'),
        ];
    }
}
