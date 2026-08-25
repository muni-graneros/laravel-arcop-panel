<?php

namespace Muni\Arcop\Tests\Fixtures;

use Illuminate\Foundation\Auth\User as Authenticatable;

class UsuarioDePrueba extends Authenticatable
{
    protected $table = 'usuarios_de_prueba';

    protected $guarded = [];
}
