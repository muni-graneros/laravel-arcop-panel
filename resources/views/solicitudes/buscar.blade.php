@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Buscar a la persona · '.config('arcop-panel.titulo'))

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <h1>Recibir una solicitud: paso 1 de 2</h1>
    <p class="arcop-guia">Buscá a la persona cuyos datos se piden. Si no aparece, no se puede recibir la
        solicitud en este sistema.</p>

    <form class="arcop-busqueda" method="GET" action="{{ route('arcop.solicitudes.buscar') }}">
        <div class="arcop-campo">
            <label for="q">Nombre o documento</label>
            {{-- El botón va DENTRO del campo, pegado al input: si queda fuera,
                 se alinea con el fondo del bloque —que incluye la línea de
                 ayuda— y aparece un escalón respecto del cuadro de texto. --}}
            <div class="arcop-campo__fila">
                <input id="q" name="q" type="search" value="{{ $termino }}" autofocus
                       aria-describedby="q-ayuda" minlength="{{ $minimo }}">
                <button class="arcop-boton arcop-boton--principal" type="submit">Buscar</button>
            </div>
            <p id="q-ayuda" class="arcop-ayuda">Escribí al menos {{ $minimo }} caracteres.</p>
        </div>
    </form>

    @if ($termino !== '' && ! $buscoDeVerdad)
        <p class="arcop-aviso arcop-aviso--error" role="alert">
            Escribí al menos {{ $minimo }} caracteres: con menos, la búsqueda devolvería medio padrón.
        </p>
    @elseif ($buscoDeVerdad && $resultados === [])
        <p class="arcop-vacio">Nadie calza con «{{ $termino }}» en este sistema.</p>
    @elseif ($buscoDeVerdad)
        <h2>Resultados</h2>
        <ul class="arcop-resultados">
            @foreach ($resultados as $clave => $etiqueta)
                <li>
                    <span>{{ $etiqueta }}</span>
                    <a class="arcop-boton" href="{{ route('arcop.solicitudes.formulario', $clave) }}">
                        Elegir<span class="arcop-sr"> a {{ $etiqueta }}</span>
                    </a>
                </li>
            @endforeach
        </ul>
    @endif
@endsection
