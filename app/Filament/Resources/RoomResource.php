<?php

namespace App\Filament\Resources;

use App\Filament\Resources\RoomResource\Pages;
use App\Filament\Resources\RoomResource\RelationManagers;
use App\Models\Room;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\SoftDeletingScope;

class RoomResource extends Resource
{
    protected static ?string $model = Room::class;

    protected static ?string $navigationIcon = 'heroicon-o-rectangle-stack';

    public static function form(Form $form): Form
    {
        return $form
            ->schema([
                Forms\Components\TextInput::make('room_id')
                    ->required()
                    ->numeric(),
                Forms\Components\TextInput::make('name')
                    ->maxLength(255),
                Forms\Components\TextInput::make('image_url')
                    ->url()
                    ->maxLength(2000),
                Forms\Components\TextInput::make('population')
                    ->required()
                    ->numeric()
                    ->default(0),
                Forms\Components\Toggle::make('is_spamming')
                    ->required(),
                Forms\Components\Select::make('language')
                    ->options([
                        'Hinglish' => 'Hinglish (Hindi / English)',
                        'Manglish' => 'Manglish (Malayalam / English)',
                        'Tanglish' => 'Tanglish (Tamil / English)',
                        'English' => 'English Default',
                    ])
                    ->default('Hinglish')
                    ->required(),
                Forms\Components\Select::make('persona_mode')
                    ->options([
                        'Sarcastic' => 'Sarcastic (Default)',
                        'Roasting' => 'Roasting (Mean/Insulting)',
                        'Flirty' => 'Flirty / Rage Bait (Gender based)',
                    ])
                    ->default('Sarcastic')
                    ->required(),
                Forms\Components\Toggle::make('is_ai_active')
                    ->default(true)
                    ->required(),
                Forms\Components\TagsInput::make('visitors')
                    ->label('Currently Online Visitors')
                    ->disabled(),
            ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\ImageColumn::make('image_url')
                    ->circular()
                    ->label('Thumbnail'),
                Tables\Columns\TextColumn::make('name')
                    ->searchable()
                    ->weight('bold'),
                Tables\Columns\TextColumn::make('room_id')
                    ->numeric()
                    ->sortable()
                    ->color('gray'),
                Tables\Columns\TextColumn::make('population')
                    ->numeric()
                    ->sortable(),
                Tables\Columns\TextColumn::make('visitors')
                    ->label('Visitors')
                    ->badge()
                    ->separator(',')
                    ->limitList(3),
                Tables\Columns\ToggleColumn::make('is_spamming')
                    ->label('Spam Engine Active'),
                Tables\Columns\SelectColumn::make('language')
                    ->options([
                        'Hinglish' => 'Hinglish',
                        'Manglish' => 'Manglish',
                        'Tanglish' => 'Tanglish',
                        'English' => 'English',
                    ]),
                Tables\Columns\SelectColumn::make('persona_mode')
                    ->options([
                        'Sarcastic' => 'Sarcastic',
                        'Roasting' => 'Roasting',
                        'Flirty' => 'Flirty',
                    ]),
                Tables\Columns\ToggleColumn::make('is_ai_active')
                    ->label('AI Chat Active'),
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
                Tables\Actions\EditAction::make(),
                Tables\Actions\Action::make('send_message')
                    ->label('Send Message')
                    ->icon('heroicon-o-chat-bubble-left-ellipsis')
                    ->color('info')
                    ->form([
                        Forms\Components\Textarea::make('message')
                            ->label('Chat directly to the room')
                            ->required()
                            ->maxLength(1000),
                    ])
                    ->action(function (Room $record, array $data): void {
                        $record->update(['pending_message' => $data['message']]);
                    }),
                Tables\Actions\Action::make('kick_user')
                    ->label('Kick User')
                    ->icon('heroicon-o-x-circle')
                    ->color('danger')
                    ->form([
                        Forms\Components\TextInput::make('username')
                            ->label('Username to Kick (Case Insensitive)')
                            ->required()
                            ->maxLength(255),
                    ])
                    ->action(function (Room $record, array $data): void {
                        $record->update(['pending_kick_username' => $data['username']]);
                    }),
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
            'index' => Pages\ListRooms::route('/'),
            'create' => Pages\CreateRoom::route('/create'),
            'edit' => Pages\EditRoom::route('/{record}/edit'),
        ];
    }
}
